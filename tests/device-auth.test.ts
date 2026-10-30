import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from './helpers/do-state.ts';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {
      (ctx as any).getWebSockets ??= () => [];
    }
  },
}));
import { RegistryDO } from '../apps/relay/src/registry.ts';
import { HostRelayDO } from '../apps/relay/src/host.ts';
import worker from '../apps/relay/src/index.ts';
import type { Env } from '../apps/relay/src/common.ts';

class Storage extends MemoryStorage {}
let storage: Storage, registry: RegistryDO, env: Env;
async function op(name: string, data: unknown = {}) {
  const r = await registry.fetch(
    new Request('https://internal/' + name, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  );
  return { status: r.status, data: (await r.json()) as any };
}
async function grant(role: string, hostId?: string) {
  const request = (
    await op('deviceStart', {
      role,
      name: 'test',
      ip: 'test',
    })
  ).data;
  expect(
    (
      await op('deviceApprove', {
        id: request.id,
        ...(role !== 'agent' ? { hostId } : {}),
      })
    ).status,
  ).toBe(200);
  return (
    await op('devicePoll', {
      id: request.id,
      pollSecret: request.pollSecret,
      web: role === 'web',
    })
  ).data;
}
async function agentRequest(path: string, token?: string, data?: unknown) {
  const response = await worker.fetch(
    new Request('https://relay.test/api/v1/agent/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        Origin: 'https://relay.test',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    }),
    env,
  );
  return { status: response.status, data: (await response.json()) as any };
}
beforeEach(() => {
  storage = new Storage();
  env = {
    OWNER_SECRET: 'x'.repeat(64),
    REGISTRY: {
      idFromName: () => 'registry',
      get: () => ({
        fetch: (url: string, options: any) =>
          registry.fetch(new Request(url, options)),
      }),
    },
  } as unknown as Env;
  registry = new RegistryDO({ storage } as unknown as DurableObjectState, env);
});
describe('scoped persistent device authorization', () => {
  it.each([400, 503])(
    'does not turn Registry HTTP %s failures into missing browser credentials',
    async (status) => {
      const agent = await grant('agent');
      const web = await grant('web', agent.hostId);
      const original = registry.fetch.bind(registry);
      const mocked = vi
        .spyOn(registry, 'fetch')
        .mockImplementation((request) =>
          new URL(request.url).pathname === '/authHost'
            ? Promise.resolve(
                Response.json(
                  {
                    error: {
                      code:
                        status === 400 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR',
                      message: 'Synthetic backend failure',
                    },
                  },
                  { status },
                ),
              )
            : original(request),
        );
      try {
        const response = await worker.fetch(
          new Request('https://relay.test/api/v1/hosts', {
            headers: { Cookie: `coc_web_${agent.hostId}=${web.token}` },
          }),
          env,
        );
        expect(response.status).toBe(status);
        expect(((await response.json()) as any).error.code).not.toBe(
          'UNAUTHORIZED',
        );
      } finally {
        mocked.mockRestore();
      }
    },
  );
  it('records only successful authentication, throttles last-seen writes, and never revives revoked credentials', async () => {
    const agent = await grant('agent');
    const client = await grant('cli', agent.hostId);
    const before = (await op('devices')).data.credentials;
    expect(before.every((d: any) => d.lastSeen === undefined)).toBe(true);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
    try {
      const first = await op('auth', { token: client.token });
      expect(first.status).toBe(200);
      expect(first.data.lastSeen).toBe(1800000000000);
      clock.mockReturnValue(1800000020000);
      expect(
        (await op('authHash', { hash: first.data.hash })).data.lastSeen,
      ).toBe(1800000000000);
      clock.mockReturnValue(1800000060000);
      expect(
        (await op('authHost', { token: client.token })).data.lastSeen,
      ).toBe(1800000060000);
      const listed = (await op('devices')).data.credentials.find(
        (d: any) => d.id === first.data.hash,
      );
      expect(listed.lastSeen).toBe(1800000060000);
      await op('credentialRevoke', { id: first.data.hash });
      expect((await op('auth', { token: client.token })).status).toBe(401);
      expect(storage.values.has('auth:' + first.data.hash)).toBe(false);
      expect((await op('auth', { token: 'invalid-token' })).status).toBe(401);
    } finally {
      clock.mockRestore();
    }
  });
  it('excludes legacy hosts from management and release fanout without deleting stored records', async () => {
    const legacy = {
      id: crypto.randomUUID(),
      name: 'build-server',
      disabled: false,
      agentWakeUrl: 'https://wake.example.com/start',
    };
    storage.values.set('host:' + legacy.id, legacy);
    const current = await grant('agent');
    const notify = vi.fn<(id: string) => Promise<Response>>(async () =>
      Response.json({ ok: true }),
    );
    env.HOSTS = {
      idFromName: (id: string) => id,
      get: (id: string) => ({ fetch: () => notify(id) }),
    } as unknown as DurableObjectNamespace;
    expect(
      (await op('hosts')).data.map((host: { id: string }) => host.id),
    ).toEqual([current.hostId]);
    expect(
      (await op('devices')).data.credentials.map(
        (auth: { hostId: string }) => auth.hostId,
      ),
    ).toEqual([current.hostId]);
    expect((await op('host', { id: legacy.id })).status).toBe(404);
    expect(
      (await op('setWakeUrl', { id: legacy.id, wakeUrl: null })).status,
    ).toBe(404);
    await op('releasePublish', { version: '0.5.12', commit: 'a'.repeat(40) });
    expect(notify.mock.calls.map(([id]) => id)).toEqual([current.hostId]);
    expect(storage.values.get('host:' + legacy.id)).toEqual(legacy);
    const auth = (await op('auth', { token: current.token })).data;
    await op('credentialRevoke', { id: auth.hash });
    expect((await op('hosts')).data).toMatchObject([
      { id: current.hostId, disabled: true },
    ]);
  });
  it('keeps management changes local and targets host snapshot notifications', async () => {
    const notify = vi.fn<
      (id: string, data: { scope: string }) => Promise<Response>
    >(async () => Response.json({ ok: true }));
    env.HOSTS = {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        fetch: (url: string, init: RequestInit) =>
          notify(id, JSON.parse(init.body as string)),
      }),
    } as unknown as DurableObjectNamespace;
    const a = await grant('agent'),
      b = await grant('agent');
    notify.mockClear();
    const owner = (await op('login', { secret: env.OWNER_SECRET, ip: 'owner' }))
      .data;
    await op('logoutOthers', { hash: owner.token });
    await op('apiKeyCreate', { role: 'cli', name: 'key', hostId: a.hostId });
    await op('deviceStart', { role: 'agent', name: 'unassigned' });
    expect(notify).not.toHaveBeenCalled();

    await op('setWakeUrl', { id: a.hostId, wakeUrl: null });
    expect(notify.mock.calls.map(([id]) => id)).toEqual([a.hostId]);
    notify.mockClear();
    const request = (
      await op('deviceStart', {
        role: 'cli',
        name: 'targeted',
        requestedHostId: b.hostId,
      })
    ).data;
    await op('deviceApprove', { id: request.id });
    expect(notify.mock.calls.map(([id]) => id)).toEqual([b.hostId, b.hostId]);
    expect(
      notify.mock.calls.every(([, data]) => data.scope === 'requests'),
    ).toBe(true);

    notify.mockClear();
    const unassigned = (
      await op('deviceStart', { role: 'cli', name: 'unassigned' })
    ).data;
    await op('deviceApprove', { id: unassigned.id, hostId: a.hostId });
    expect(notify.mock.calls.map(([id]) => id)).toEqual([a.hostId]);
    notify.mockClear();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(unassigned.expires);
    try {
      await registry.alarm();
    } finally {
      clock.mockRestore();
    }
    expect(
      notify.mock.calls.every(([id]) => id === a.hostId || id === b.hostId),
    ).toBe(true);
    expect(notify).toHaveBeenCalledTimes(4);

    notify.mockClear();
    // The unclaimed client grants expired, but the delivered Agents survive.
    const release = { version: '0.5.12', commit: 'a'.repeat(40) };
    await op('releasePublish', release);
    expect(notify.mock.calls.map(([id]) => id).sort()).toEqual(
      [a.hostId, b.hostId].sort(),
    );
    notify.mockClear();
    await op('releasePublish', release);
    expect(notify).not.toHaveBeenCalled();
  });
  it('targets rename, Agent configuration and revocation changes without suppressing them', async () => {
    const a = await grant('agent');
    await grant('agent');
    const auth = (await op('auth', { token: a.token })).data;
    const calls: string[] = [];
    env.HOSTS = {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        fetch: async () => {
          calls.push(id);
          return Response.json({ ok: true });
        },
      }),
    } as unknown as DurableObjectNamespace;
    expect(
      (await op('setInstanceName', { hash: auth.hash, displayName: 'renamed' }))
        .status,
    ).toBe(200);
    expect(
      (
        await op('agentSetWakeUrl', {
          agentHash: auth.hash,
          wakeUrl: 'https://wake.example.com/start',
        })
      ).status,
    ).toBe(200);
    const key = (
      await op('apiKeyCreate', {
        role: 'cli',
        hostId: a.hostId,
        name: 'test key',
      })
    ).data;
    expect(
      (
        await op('apiKeyLogin', {
          role: 'cli',
          apiKey: key.apiKey,
          hostId: a.hostId,
          name: 'client',
        })
      ).status,
    ).toBe(200);
    expect((await op('apiKeyRevoke', { id: key.id })).status).toBe(200);
    expect((await op('credentialRevoke', { id: auth.hash })).status).toBe(200);
    expect(calls).toEqual(Array(5).fill(a.hostId));
    expect((await op('auth', { token: a.token })).status).toBe(401);
    expect((await op('auth', { token: key.apiKey })).status).toBe(401);
  });
  it.each(['cli', 'web'])(
    'lets only the explicitly requested Agent approve a %s request',
    async (role) => {
      const a = await grant('agent'),
        b = await grant('agent');
      const start = (requestedHostId?: string) =>
        op('deviceStart', {
          role,
          name: 'targeted client',
          requestedHostId,
          message: '核对配对码',
        });
      const own = (await start(a.hostId)).data;
      const foreign = (await start(b.hostId)).data;
      const unassigned = (await start()).data;
      const newAgent = (
        await op('deviceStart', { role: 'agent', name: 'new A' })
      ).data;
      expect(own.requestedHostId).toBe(a.hostId);
      const listed = await agentRequest('requests', a.token);
      expect(listed.status).toBe(200);
      expect(listed.data.hostId).toBe(a.hostId);
      expect(listed.data.pending).toEqual([
        expect.objectContaining({
          id: own.id,
          code: own.code,
          role,
          requestedHostId: a.hostId,
          message: '核对配对码',
        }),
      ]);
      expect(listed.data.pending[0]).not.toHaveProperty('pollHash');
      expect(listed.data.pending[0]).not.toHaveProperty('pollSecret');
      expect(listed.data).not.toHaveProperty('credentials');
      for (const id of [foreign.id, unassigned.id, newAgent.id]) {
        for (const decision of ['approve', 'reject'])
          expect(
            (
              await agentRequest(`requests/${id}/${decision}`, a.token, {
                hostId: a.hostId,
              })
            ).status,
          ).toBe(403);
      }
      expect(
        (await op('deviceApprove', { id: own.id, hostId: b.hostId })).status,
      ).toBe(403);
      expect(
        (
          await agentRequest(`requests/${own.id}/approve`, b.token, {
            agentHash: (await op('auth', { token: a.token })).data.hash,
          })
        ).status,
      ).toBe(403);
      const approved = await agentRequest(
        `requests/${own.id}/approve`,
        a.token,
        { hostId: b.hostId },
      );
      expect(approved).toEqual({ status: 200, data: { ok: true } });
      expect((await agentRequest('requests', a.token)).data.pending).toEqual(
        [],
      );
      const delivered = await op('devicePoll', {
        id: own.id,
        pollSecret: own.pollSecret,
        web: role === 'web',
      });
      expect(delivered.data).toMatchObject({
        state: 'approved',
        role,
        hostId: a.hostId,
      });
      expect(
        (await op('auth', { token: delivered.data.token })).data.hostId,
      ).toBe(a.hostId);
      expect(
        (
          await op('devicePoll', {
            id: own.id,
            pollSecret: own.pollSecret,
            web: role === 'web',
          })
        ).status,
      ).toBe(role === 'web' ? 401 : 200);
    },
  );
  it('requires live Agent credentials at the route and inside the approval transaction', async () => {
    const a = await grant('agent');
    const cc = await grant('cli', a.hostId),
      cw = await grant('web', a.hostId);
    const owner = (await op('login', { secret: env.OWNER_SECRET })).data;
    const request = (
      await op('deviceStart', {
        role: 'cli',
        name: 'client',
        requestedHostId: a.hostId,
      })
    ).data;
    for (const token of [undefined, cc.token, cw.token, owner.token]) {
      expect((await agentRequest('requests', token)).status).toBe(
        token ? 403 : 401,
      );
      expect(
        (await agentRequest(`requests/${request.id}/approve`, token, {}))
          .status,
      ).toBe(token ? 403 : 401);
    }
    const auth = (await op('auth', { token: a.token })).data;
    // Simulate revocation after the Worker authorized the token, before the transaction.
    await op('credentialRevoke', { id: auth.hash });
    expect(
      (await op('agentDeviceApprove', { id: request.id, agentHash: auth.hash }))
        .status,
    ).toBe(401);
    expect((await agentRequest('requests', a.token)).status).toBe(401);
    expect((await op('devices')).data.pending).toHaveLength(1);
    expect((await op('deviceApprove', { id: request.id })).status).toBe(404);
  });
  it('rechecks disabled hosts and API key revocation even with a captured Agent hash', async () => {
    const key = (await op('apiKeyCreate', { role: 'agent', name: 'A key' }))
      .data;
    const a = (
      await op('apiKeyLogin', { apiKey: key.apiKey, role: 'agent', name: 'A' })
    ).data;
    const request = (
      await op('deviceStart', {
        role: 'web',
        name: 'CW',
        requestedHostId: a.hostId,
      })
    ).data;
    expect(
      (await agentRequest('requests', key.apiKey)).data.pending,
    ).toHaveLength(1);
    const host = storage.values.get('host:' + a.hostId);
    storage.values.set('host:' + a.hostId, { ...host, disabled: true });
    expect(
      (await op('agentDeviceApprove', { id: request.id, agentHash: key.id }))
        .status,
    ).toBe(401);
    storage.values.set('host:' + a.hostId, host);
    storage.values.delete('apiKey:' + key.id);
    expect((await op('agentDevices', { agentHash: key.id })).status).toBe(401);
    expect(
      (await op('agentDeviceReject', { id: request.id, agentHash: key.id }))
        .status,
    ).toBe(401);
  });
  it('serializes Agent and administrator approval and preserves the requested target', async () => {
    const a = await grant('agent');
    const request = (
      await op('deviceStart', {
        role: 'cli',
        name: 'client',
        requestedHostId: a.hostId,
      })
    ).data;
    const results = await Promise.all([
      agentRequest(`requests/${request.id}/approve`, a.token, {}),
      op('deviceApprove', { id: request.id }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (await op('devices')).data.credentials.filter(
        (a: any) => a.role === 'cli',
      ),
    ).toHaveLength(1);
    const result = await op('devicePoll', {
      id: request.id,
      pollSecret: request.pollSecret,
      web: false,
    });
    expect(result.data.hostId).toBe(a.hostId);
  });
  it('validates explicit targets, expires requests and permits scoped rejection', async () => {
    const a = await grant('agent');
    for (const requestedHostId of ['', null, 123, 'bad/path'])
      expect(
        (
          await op('deviceStart', {
            role: 'cli',
            name: 'client',
            requestedHostId,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await op('deviceStart', {
          role: 'web',
          name: 'client',
          requestedHostId: 'unknown',
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await op('deviceStart', {
          role: 'agent',
          name: 'agent',
          requestedHostId: a.hostId,
        })
      ).status,
    ).toBe(400);
    const request = (
      await op('deviceStart', {
        role: 'web',
        name: 'client',
        requestedHostId: a.hostId,
      })
    ).data;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    try {
      expect((await agentRequest('requests', a.token)).data.pending).toEqual(
        [],
      );
      expect(
        (await agentRequest(`requests/${request.id}/approve`, a.token, {}))
          .status,
      ).toBe(409);
    } finally {
      clock.mockRestore();
    }
    expect(
      (await agentRequest(`requests/${request.id}/reject`, a.token, {})).status,
    ).toBe(200);
    expect(
      (
        await op('devicePoll', {
          id: request.id,
          pollSecret: request.pollSecret,
          web: true,
        })
      ).data.state,
    ).toBe('rejected');
  });
  it.each(['web', 'cli'])(
    'takes a %s message without a host and binds only the administrator-selected host',
    async (role) => {
      const a = await grant('agent'),
        b = await grant('agent');
      const started = await op('deviceStart', {
        role,
        name: 'client',
        message: '  请授权测试服务器\n用于开发 <script>  ',
        hostId: a.hostId,
      });
      expect(started.status).toBe(200);
      expect(started.data.hostId).toBeUndefined();
      const pending = (await op('devices')).data.pending[0];
      expect(pending).toMatchObject({
        name: 'client',
        role,
        message: '请授权测试服务器\n用于开发 <script>',
      });
      expect(pending.hostId).toBeUndefined();
      expect((await op('deviceApprove', { id: pending.id })).status).toBe(400);
      expect(
        (await op('deviceApprove', { id: pending.id, hostId: 'unknown' }))
          .status,
      ).toBe(404);
      const aAuth = (await op('auth', { token: a.token })).data;
      await op('credentialRevoke', { id: aAuth.hash });
      expect(
        (await op('deviceApprove', { id: pending.id, hostId: a.hostId }))
          .status,
      ).toBe(404);
      expect((await op('devices')).data.pending).toHaveLength(1);
      expect((await op('devices')).data.credentials).toHaveLength(1);
      expect(
        (await op('deviceApprove', { id: pending.id, hostId: b.hostId }))
          .status,
      ).toBe(200);
      expect(
        (await op('deviceApprove', { id: pending.id, hostId: a.hostId }))
          .status,
      ).toBe(409);
      const result = await op('devicePoll', {
        id: pending.id,
        pollSecret: started.data.pollSecret,
        web: role === 'web',
      });
      expect(result.data).toMatchObject({
        state: 'approved',
        hostId: b.hostId,
        role,
      });
      expect((await op('auth', { token: result.data.token })).data.hostId).toBe(
        b.hostId,
      );
      expect(
        (
          await op('devicePoll', {
            id: pending.id,
            pollSecret: started.data.pollSecret,
            web: role === 'web',
          })
        ).status,
      ).toBe(role === 'web' ? 401 : 200);
    },
  );
  it.each(['web', 'cli'])(
    'bounds %s messages and permits rejection without selecting a target',
    async (role) => {
      for (const message of ['x'.repeat(1001), 123, null])
        expect(
          (await op('deviceStart', { role, name: 'client', message })).status,
        ).toBe(400);
      const request = (
        await op('deviceStart', {
          role,
          name: 'browser',
          message: 'x'.repeat(1000),
        })
      ).data;
      expect((await op('deviceReject', { id: request.id })).status).toBe(200);
      expect(
        (
          await op('devicePoll', {
            id: request.id,
            pollSecret: request.pollSecret,
            web: role === 'web',
          })
        ).data.state,
      ).toBe('rejected');
      expect(
        (await op('deviceStart', { role, name: 'no message' })).status,
      ).toBe(200);
    },
  );
  it('revokes administrator sessions on logout, other-session logout and owner rotation', async () => {
    const first = (await op('login', { secret: env.OWNER_SECRET })).data;
    const second = (await op('login', { secret: env.OWNER_SECRET })).data;
    const device = await grant('agent');
    const request = (path: string, token: string) =>
      worker.fetch(
        new Request('https://relay.test/api/v1' + path, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + token,
            Origin: 'https://relay.test',
          },
        }),
        env,
      );
    expect((await request('/auth/logout-others', first.token)).status).toBe(
      200,
    );
    expect((await op('auth', { token: second.token })).status).toBe(401);
    expect((await op('auth', { token: first.token })).status).toBe(200);
    expect((await op('auth', { token: device.token })).status).toBe(200);
    expect((await request('/auth/logout', first.token)).status).toBe(200);
    expect((await op('auth', { token: first.token })).status).toBe(401);
    const third = (await op('login', { secret: env.OWNER_SECRET })).data;
    env.OWNER_SECRET = 'rotated'.repeat(10);
    expect((await op('auth', { token: third.token })).status).toBe(401);
    expect((await op('auth', { token: device.token })).status).toBe(200);
  });
  it('keeps credentials valid years later and rejects legacy broad credentials', async () => {
    const a = await grant('agent');
    const cc = await grant('cli', a.hostId);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 10 * 365 * 86400000);
    try {
      expect((await op('auth', { token: cc.token })).status).toBe(200);
    } finally {
      clock.mockRestore();
    }
    const record = [...storage.values].find(
      ([k, v]) => k.startsWith('auth:') && v.role === 'cli',
    )!;
    delete record[1].version;
    expect((await op('auth', { token: cc.token })).status).toBe(401);
  });
  it('requires the polling secret, approves once and recovers the same native grant', async () => {
    const request = (await op('deviceStart', { role: 'agent', name: 'test' }))
      .data;
    expect(
      (
        await op('devicePoll', {
          id: request.id,
          pollSecret: 'wrong',
          web: false,
        })
      ).status,
    ).toBe(401);
    const approvals = await Promise.all([
      op('deviceApprove', { id: request.id }),
      op('deviceApprove', { id: request.id }),
    ]);
    expect(approvals.map((r) => r.status).sort()).toEqual([200, 409]);
    const deliveries = await Promise.all([
      op('devicePoll', {
        id: request.id,
        pollSecret: request.pollSecret,
        web: false,
      }),
      op('devicePoll', {
        id: request.id,
        pollSecret: request.pollSecret,
        web: false,
      }),
    ]);
    expect(deliveries.map((r) => r.status)).toEqual([200, 200]);
    expect(deliveries[0].data).toEqual(deliveries[1].data);
    expect((await op('devices')).data.pending).toEqual([]);
    expect((await op('devices')).data.credentials).toHaveLength(1);
    const poll = (pollSecret = request.pollSecret) =>
      op('devicePoll', { id: request.id, pollSecret, web: false });
    expect((await poll('wrong')).status).toBe(401);
    const auth = (await op('auth', { token: deliveries[0].data.token })).data;
    await op('credentialRevoke', { id: auth.hash });
    expect((await poll()).status).toBe(401);
  });
  it('bounds native grant recovery by expiry and keeps web delivery single-use', async () => {
    const a = await grant('agent');
    for (const role of ['agent', 'cli', 'web']) {
      const request = (await op('deviceStart', { role, name: 'recovery' }))
        .data;
      await op('deviceApprove', { id: request.id, hostId: a.hostId });
      const poll = () =>
        op('devicePoll', {
          id: request.id,
          pollSecret: request.pollSecret,
          web: role === 'web',
        });
      const first = await poll();
      expect(first.status).toBe(200);
      const second = await poll();
      if (role === 'web') expect(second.status).toBe(401);
      else {
        expect(second.data).toEqual(first.data);
        const clock = vi.spyOn(Date, 'now').mockReturnValue(request.expires);
        try {
          expect((await poll()).status).toBe(401);
          await registry.alarm();
          expect((await op('auth', { token: first.data.token })).status).toBe(
            200,
          );
          expect(storage.values.has('device:' + request.id)).toBe(false);
        } finally {
          clock.mockRestore();
        }
      }
    }
  });
  it('rejects native grant recovery after its target Agent is revoked', async () => {
    const a = await grant('agent');
    const request = (await op('deviceStart', { role: 'cli', name: 'recovery' }))
      .data;
    await op('deviceApprove', { id: request.id, hostId: a.hostId });
    const poll = () =>
      op('devicePoll', {
        id: request.id,
        pollSecret: request.pollSecret,
        web: false,
      });
    expect((await poll()).status).toBe(200);
    const auth = (await op('auth', { token: a.token })).data;
    await op('credentialRevoke', { id: auth.hash });
    expect((await poll()).status).toBe(401);
  });
  it('expires requests, supports rejection and hides polling secrets from administrators', async () => {
    const request = (await op('deviceStart', { role: 'agent', name: 'test' }))
      .data;
    expect((await op('devices')).data.pending[0].pollHash).toBeUndefined();
    await op('deviceReject', { id: request.id });
    expect(
      (
        await op('devicePoll', {
          id: request.id,
          pollSecret: request.pollSecret,
          web: false,
        })
      ).data.state,
    ).toBe('rejected');
    const expired = (
      await op('deviceStart', { role: 'agent', name: 'expired' })
    ).data;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    try {
      expect((await op('deviceApprove', { id: expired.id })).status).toBe(409);
    } finally {
      clock.mockRestore();
    }
  });
  it('revokes one client independently and cascades A revocation to its clients', async () => {
    const a = await grant('agent');
    const cc = await grant('cli', a.hostId);
    const cw = await grant('web', a.hostId);
    const ccAuth = (await op('auth', { token: cc.token })).data;
    await op('credentialRevoke', { id: ccAuth.hash });
    expect((await op('auth', { token: cc.token })).status).toBe(401);
    expect((await op('auth', { token: cw.token })).status).toBe(200);
    const agentAuth = (await op('auth', { token: a.token })).data;
    await op('credentialRevoke', { id: agentAuth.hash });
    expect((await op('auth', { token: a.token })).status).toBe(401);
    expect((await op('auth', { token: cw.token })).status).toBe(401);
  });
  it('binds browser cookies to their A and rejects browser management access', async () => {
    const a = await grant('agent'),
      b = await grant('agent'),
      cw = await grant('web', a.hostId);
    const headers = { Cookie: 'coc_web_' + a.hostId + '=' + cw.token };
    expect(
      (
        await worker.fetch(
          new Request(
            'https://relay.test/api/v1/hosts/' + b.hostId + '/projects',
            { headers },
          ),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(
          new Request('https://relay.test/api/v1/admin/devices', { headers }),
          env,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.fetch(
          new Request('https://relay.test/api/v1/agent/status', { headers }),
          env,
        )
      ).status,
    ).toBe(401);
    expect((await op('auth', { token: cw.token })).data.hostId).toBe(a.hostId);
  });
  it('registers more than five active Agents and queues more than 200 login requests', async () => {
    const agents = [];
    for (let i = 0; i < 7; i++) agents.push(await grant('agent'));
    for (const agent of agents)
      expect((await op('auth', { token: agent.token })).status).toBe(200);
    for (let i = 0; i < 205; i++)
      expect(
        (
          await op('deviceStart', {
            role: 'cli',
            name: `client-${i}`,
            ip: `test-${i}`,
          })
        ).status,
      ).toBe(200);
    expect((await op('devices')).data.pending).toHaveLength(205);
  });
  it('cleans unclaimed grants and releases revoked A capacity', async () => {
    const unclaimed = (
      await op('deviceStart', { role: 'agent', name: 'unclaimed' })
    ).data;
    await op('deviceApprove', { id: unclaimed.id });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    try {
      await registry.alarm();
    } finally {
      clock.mockRestore();
    }
    expect((await op('devices')).data.credentials).toHaveLength(0);
    expect((await op('host', { id: unclaimed.hostId })).status).toBe(404);
    for (let i = 0; i < 6; i++) {
      const a = await grant('agent');
      const auth = (await op('auth', { token: a.token })).data;
      await op('credentialRevoke', { id: auth.hash });
    }
    expect((await op('devices')).data.credentials).toHaveLength(0);
  });
  it('blocks wrong host, agent-to-client, client-to-agent and client-to-management access', async () => {
    const a = await grant('agent');
    const b = await grant('agent');
    const cc = await grant('cli', a.hostId);
    const request = (path: string, token: string) =>
      worker.fetch(
        new Request('https://relay.test' + path, {
          headers: { Authorization: 'Bearer ' + token },
        }),
        env,
      );
    expect(
      (await request('/api/v1/hosts/' + b.hostId + '/projects', cc.token))
        .status,
    ).toBe(403);
    expect((await request('/api/v1/hosts', a.token)).status).toBe(403);
    expect((await request('/api/v1/agent/status', cc.token)).status).toBe(403);
    expect((await request('/api/v1/admin/devices', cc.token)).status).toBe(403);
    expect((await request('/api/v1/admin/devices', a.token)).status).toBe(403);
  });
});

describe('role restricted direct API keys', () => {
  const create = async (role: string, hostId?: string) =>
    (await op('apiKeyCreate', { role, hostId, name: 'automation' })).data;
  const login = (key: any, role: string, hostId?: string) =>
    op('apiKeyLogin', {
      apiKey: key.apiKey,
      role,
      hostId,
      name: 'installation',
    });
  it('requires a role and fixes CC target at creation, including direct bearer access', async () => {
    const a = await grant('agent'),
      b = await grant('agent');
    expect((await op('apiKeyCreate', { name: 'missing role' })).status).toBe(
      400,
    );
    expect(
      (await op('apiKeyCreate', { name: 'wrong role', role: 'web' })).status,
    ).toBe(400);
    expect(
      (await op('apiKeyCreate', { name: 'no host', role: 'cli' })).status,
    ).toBe(400);
    const key = await create('cli', a.hostId);
    expect((await op('auth', { token: key.apiKey })).data).toMatchObject({
      role: 'cli',
      hostId: a.hostId,
      hash: key.id,
    });
    expect((await login(key, 'agent')).status).toBe(403);
    expect((await login(key, 'cli', b.hostId)).status).toBe(403);
    const result = await login(key, 'cli', a.hostId);
    expect(result.status).toBe(200);
    expect(result.data.token).toBeUndefined();
    expect((await op('apiKeys')).data[0]).not.toHaveProperty('apiKey');
    expect(JSON.stringify([...storage.values.values()])).not.toContain(
      key.apiKey,
    );
    const request = (path: string) =>
      worker.fetch(
        new Request('https://relay.test/api/v1' + path, {
          headers: { Authorization: 'Bearer ' + key.apiKey },
        }),
        env,
      );
    expect((await request('/admin/api-keys')).status).toBe(403);
    expect((await request('/agent/status')).status).toBe(403);
    expect((await request('/hosts/' + b.hostId + '/projects')).status).toBe(
      403,
    );
  });
  it('binds an A key exactly once across concurrent first uses and keeps the key itself valid', async () => {
    const key = await create('agent');
    expect((await op('auth', { token: key.apiKey })).status).toBe(401);
    const results = await Promise.all([
      login(key, 'agent'),
      login(key, 'agent'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(results[0].data.hostId).toBe(results[1].data.hostId);
    expect((await op('hosts')).data).toHaveLength(1);
    expect((await op('apiKeys')).data[0].hostId).toBe(results[0].data.hostId);
    expect((await login(key, 'cli', results[0].data.hostId)).status).toBe(403);
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.now() + 10 * 365 * 86400000);
    try {
      expect((await op('auth', { token: key.apiKey })).status).toBe(200);
    } finally {
      clock.mockRestore();
    }
  });
  it('revokes CC keys independently and revokes bound A keys with every client authorization', async () => {
    const aKey = await create('agent');
    const a = (await login(aKey, 'agent')).data;
    const cc = await create('cli', a.hostId),
      other = await create('cli', a.hostId);
    const paired = await grant('web', a.hostId);
    const revoked = await op('apiKeyRevoke', { id: cc.id });
    expect(revoked.data[0].hash).toBe(cc.id);
    expect((await op('auth', { token: cc.apiKey })).status).toBe(401);
    expect((await login(cc, 'cli', a.hostId)).status).toBe(401);
    expect((await op('auth', { token: other.apiKey })).status).toBe(200);
    expect((await op('auth', { token: paired.token })).status).toBe(200);
    await op('apiKeyRevoke', { id: aKey.id });
    for (const token of [aKey.apiKey, other.apiKey, paired.token])
      expect((await op('auth', { token })).status).toBe(401);
    expect((await login(aKey, 'agent')).status).toBe(401);
    expect((await op('apiKeys')).data).toHaveLength(0);
  });
  it('supports revoking an unused key and device-list revocation without rebinding', async () => {
    const unused = await create('agent');
    expect((await op('apiKeyRevoke', { id: unused.id })).data).toEqual([]);
    expect((await login(unused, 'agent')).status).toBe(401);
    const a = await grant('agent');
    const cc = await create('cli', a.hostId);
    await op('credentialRevoke', { id: cc.id });
    expect((await op('apiKeys')).data).toHaveLength(0);
    expect((await login(cc, 'cli', a.hostId)).status).toBe(401);
    expect((await op('auth', { token: a.token })).status).toBe(200);
  });
});

describe('host wake configuration and requests', () => {
  const hosts = new Map<
    string,
    { storage: Storage; online: boolean; relay: HostRelayDO }
  >();
  let visit: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    hosts.clear();
    env.HOSTS = {
      idFromName: (id: string) => id,
      get: (id: string) => {
        if (!hosts.has(id)) {
          const state = {
            storage: new Storage(),
            online: false,
            relay: undefined as unknown as HostRelayDO,
          };
          state.relay = new HostRelayDO(
            {
              storage: state.storage,
              getWebSockets: () =>
                state.online
                  ? [
                      {
                        readyState: 1,
                        deserializeAttachment: () => ({ protocol: 1 }),
                      },
                    ]
                  : [],
            } as unknown as DurableObjectState,
            env,
          );
          hosts.set(id, state);
        }
        return {
          fetch: (req: Request | string) =>
            hosts
              .get(id)!
              .relay.fetch(typeof req === 'string' ? new Request(req) : req),
        };
      },
    } as unknown as DurableObjectNamespace;
    visit = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('accepted'));
  });
  afterEach(() => vi.restoreAllMocks());
  async function request(path: string, token?: string, data?: unknown) {
    const response = await worker.fetch(
      new Request('https://relay.test/api/v1' + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          Origin: 'https://relay.test',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      }),
      env,
    );
    return { status: response.status, data: (await response.json()) as any };
  }
  async function setup() {
    const a = await grant('agent'),
      b = await grant('agent');
    const cli = await grant('cli', a.hostId),
      web = await grant('web', a.hostId);
    const owner = (await op('login', { secret: env.OWNER_SECRET, ip: 'owner' }))
      .data;
    return { a, b, cli, web, owner };
  }
  it('restricts configuration and wake to the authorized host and hides URLs from clients', async () => {
    const { a, b, cli, web, owner } = await setup();
    expect(
      (
        await agentRequest('wake-url', a.token, {
          wakeUrl: 'https://wake.test/a?secret=hidden',
          id: b.hostId,
        })
      ).status,
    ).toBe(200);
    expect(
      (await op('host', { id: b.hostId })).data.agentWakeUrl,
    ).toBeUndefined();
    for (const credential of [undefined, cli.token, web.token])
      expect(
        (await agentRequest('wake-url', credential, { wakeUrl: '' })).status,
      ).toBe(credential ? 403 : 401);
    expect(
      (
        await request(`/admin/hosts/${a.hostId}/wake-url`, cli.token, {
          wakeUrl: '',
        })
      ).status,
    ).toBe(403);
    expect(
      (await request(`/hosts/${b.hostId}/wake`, cli.token, {})).status,
    ).toBe(403);
    expect(
      (await request(`/hosts/${a.hostId}/wake`, undefined, {})).status,
    ).toBe(401);
    expect(
      (await request(`/hosts/${a.hostId}/wake`, owner.token, {})).status,
    ).toBe(403);
    expect((await request(`/hosts/${a.hostId}/wake`, a.token, {})).status).toBe(
      403,
    );
    const listed = (await request('/hosts', cli.token)).data;
    expect(listed[0].wakeConfigured).toBe(true);
    expect(JSON.stringify(listed)).not.toMatch(
      /secret|agentWakeUrl|wakeUrlOverride/,
    );
    const browser = await worker.fetch(
      new Request('https://relay.test/api/v1/hosts', {
        headers: { Cookie: `coc_web_${a.hostId}=${web.token}` },
      }),
      env,
    );
    expect(JSON.stringify(await browser.json())).not.toContain('hidden');
    expect(
      (await request(`/hosts/${a.hostId}/wake`, web.token, {})).data.state,
    ).toBe('requested');
    expect(visit).toHaveBeenCalledOnce();
  });
  it('persists administrator overrides, supports disabling and restoring the Agent URL, and skips online hosts', async () => {
    const { a, cli, owner } = await setup();
    const config = `/admin/hosts/${a.hostId}/wake-url`,
      wake = `/hosts/${a.hostId}/wake`;
    await agentRequest('wake-url', a.token, {
      wakeUrl: 'https://wake.test/agent',
    });
    expect(
      (
        await request(config, owner.token, {
          wakeUrl: 'https://wake.test/admin',
        })
      ).status,
    ).toBe(200);
    await agentRequest('wake-url', a.token, {
      wakeUrl: 'https://wake.test/changed-agent',
    });
    registry = new RegistryDO(
      { storage } as unknown as DurableObjectState,
      env,
    );
    expect((await request(wake, cli.token, {})).data.state).toBe('requested');
    expect(visit).toHaveBeenLastCalledWith(
      'https://wake.test/admin',
      expect.objectContaining({ method: 'GET', redirect: 'manual' }),
    );
    const state = hosts.get(a.hostId)!;
    await state.storage.delete('wakeUntil');
    state.online = true;
    expect((await request(wake, cli.token, {})).data.state).toBe('online');
    state.online = false;
    await request(config, owner.token, { wakeUrl: '' });
    expect((await request(wake, cli.token, {})).data.state).toBe(
      'unconfigured',
    );
    expect((await request('/hosts', cli.token)).data[0].wakeConfigured).toBe(
      false,
    );
    expect(visit).toHaveBeenCalledOnce();
    await request(config, owner.token, { wakeUrl: null });
    await request(wake, cli.token, {});
    expect(visit).toHaveBeenLastCalledWith(
      'https://wake.test/changed-agent',
      expect.anything(),
    );
  });
  it('deduplicates concurrent callers and keeps the cooldown across object recreation', async () => {
    const { a, cli, web } = await setup();
    await agentRequest('wake-url', a.token, {
      wakeUrl: 'https://wake.test/start',
    });
    const path = `/hosts/${a.hostId}/wake`;
    const results = await Promise.all([
      request(path, cli.token, {}),
      request(path, web.token, {}),
    ]);
    expect(results.map((r) => r.data.state).sort()).toEqual([
      'cooldown',
      'requested',
    ]);
    expect(visit).toHaveBeenCalledOnce();
    const state = hosts.get(a.hostId)!;
    state.relay = new HostRelayDO(
      {
        storage: state.storage,
        getWebSockets: () => [],
      } as unknown as DurableObjectState,
      env,
    );
    expect((await request(path, cli.token, {})).data.state).toBe('cooldown');
    expect(visit).toHaveBeenCalledOnce();
    await state.storage.put('wakeUntil', Date.now() - 1);
    expect((await request(path, cli.token, {})).data.state).toBe('requested');
    expect(visit).toHaveBeenCalledTimes(2);
    await op('credentialRevoke', {
      id: (await op('auth', { token: a.token })).data.hash,
    });
    expect((await request(path, cli.token, {})).status).toBe(401);
    expect(visit).toHaveBeenCalledTimes(2);
  });
  it.each(['redirect', 'error', 'timeout'])(
    'sanitizes %s failures and throttles retries',
    async (failure) => {
      const { a, cli } = await setup();
      await agentRequest('wake-url', a.token, {
        wakeUrl: 'https://wake.test/?secret=hidden',
      });
      if (failure === 'timeout')
        visit.mockRejectedValue(new Error('https://wake.test/?secret=hidden'));
      else
        visit.mockResolvedValue(
          new Response('secret=hidden', {
            status: failure === 'redirect' ? 302 : 500,
          }),
        );
      const path = `/hosts/${a.hostId}/wake`;
      const result = await request(path, cli.token, {});
      expect(result.status).toBe(502);
      expect(result.data.error.code).toBe('WAKE_FAILED');
      expect(JSON.stringify(result)).not.toContain('hidden');
      expect((await request(path, cli.token, {})).data.state).toBe('cooldown');
      expect(visit).toHaveBeenCalledOnce();
    },
  );
});

describe('native instance display names', () => {
  async function rename(token: string | undefined, displayName: unknown) {
    return worker.fetch(
      new Request('https://relay.test/api/v1/instance/name', {
        method: 'POST',
        headers: {
          Origin: 'https://relay.test',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
        body: JSON.stringify({ displayName, hash: '0'.repeat(64) }),
      }),
      env,
    );
  }
  it('renames only the authenticated instance and its own agent host', async () => {
    const agent = await grant('agent');
    const other = await grant('agent');
    const cli = await grant('cli', agent.hostId);
    expect((await rename(agent.token, ' 办公室电脑 ')).status).toBe(200);
    expect((await op('host', { id: agent.hostId })).data.name).toBe(
      '办公室电脑',
    );
    expect((await op('host', { id: other.hostId })).data.name).toBe('test');
    expect((await rename(cli.token, '我的笔记本')).status).toBe(200);
    expect((await op('auth', { token: cli.token })).data.name).toBe(
      '我的笔记本',
    );
    expect((await op('host', { id: agent.hostId })).data.name).toBe(
      '办公室电脑',
    );
  });
  it('rejects missing, web, revoked credentials and invalid names', async () => {
    const agent = await grant('agent');
    const web = await grant('web', agent.hostId);
    expect((await rename(undefined, 'name')).status).toBe(401);
    expect((await rename(web.token, 'name')).status).toBe(403);
    for (const name of ['', '  ', 'a'.repeat(101), 'bad\nname', 123])
      expect((await rename(agent.token, name)).status).toBe(400);
    const auth = (await op('auth', { token: agent.token })).data;
    await storage.delete('auth:' + auth.hash);
    expect((await rename(agent.token, 'name')).status).toBe(401);
  });
});

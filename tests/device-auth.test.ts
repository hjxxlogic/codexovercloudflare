import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
import { RegistryDO } from '../apps/relay/src/registry.ts';
import worker from '../apps/relay/src/index.ts';
import type { Env } from '../apps/relay/src/common.ts';

class Storage {
  values = new Map<string, any>();
  tail: Promise<unknown> = Promise.resolve();
  async get(key: string) {
    return structuredClone(this.values.get(key));
  }
  async put(key: string, value: any) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.values.delete(key);
  }
  async list({ prefix }: { prefix: string }) {
    return new Map(
      [...this.values]
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, v]) => [k, structuredClone(v)]),
    );
  }
  async getAlarm() {
    return 1;
  }
  async setAlarm() {}
  transaction<T>(fn: (tx: Storage) => Promise<T>) {
    const result = this.tail.then(() => fn(this));
    this.tail = result.catch(() => {});
    return result;
  }
}
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
      ).toBe(401);
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
      ).toBe(401);
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
  it('requires the polling secret and permits exactly one approval and credential delivery', async () => {
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
    expect(deliveries.map((r) => r.status).sort()).toEqual([200, 401]);
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

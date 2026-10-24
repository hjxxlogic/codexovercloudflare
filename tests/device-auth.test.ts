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
    await op('deviceStart', { role, name: 'test', hostId, ip: 'test' })
  ).data;
  expect((await op('deviceApprove', { id: request.id })).status).toBe(200);
  return (
    await op('devicePoll', {
      id: request.id,
      pollSecret: request.pollSecret,
      web: role === 'web',
    })
  ).data;
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

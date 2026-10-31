import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from './helpers/do-state.ts';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: unknown,
    ) {}
  },
}));
vi.mock('../apps/relay/src/common.ts', async (original) => ({
  ...(await original<typeof import('../apps/relay/src/common.ts')>()),
  registryCall: vi.fn(),
}));
import { registryCall, type Auth, type Env } from '../apps/relay/src/common.ts';
import { HostRelayDO } from '../apps/relay/src/host.ts';
import worker from '../apps/relay/src/index.ts';
import { ManagementRequests } from '../apps/relay/src/management.ts';
import { managementRequestSchema } from '../packages/protocol/src/management.ts';
import { AppError } from '../packages/protocol/src/index.ts';
const owner = {
  role: 'owner',
  hash: 'owner',
  expires: Number.MAX_SAFE_INTEGER,
} as Auth;
const metadata = {
  kind: 'agent',
  path: '/private/config.json',
  pid: 42,
  build: {
    version: '0.5.20',
    commit: 'a'.repeat(40),
    sourceDigest: 'b'.repeat(64),
    target: 'test',
    protocol: 1,
    capabilities: ['configuration-v1'],
    dirty: false,
  },
};
function socket(initial: any) {
  let attachment = structuredClone(initial);
  return {
    readyState: 1,
    deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment: (value: unknown) => {
      attachment = structuredClone(value);
    },
    send: vi.fn(),
    close: vi.fn(),
  };
}
function harness() {
  const storage = new MemoryStorage();
  storage.values.set('agentEpoch', 1);
  storage.values.set('expiryMigration', { prefix: 1 });
  const agent = socket({
    id: 'a',
    role: 'agent',
    auth: { ...owner, role: 'agent', hash: 'agent', hostId: 'host' },
    hostId: 'host',
    authenticated: true,
    epoch: 1,
    protocol: 1,
    deadline: owner.expires,
    managementMetadata: metadata,
  });
  const client = socket({
    id: 'client-one',
    role: 'cli',
    management: true,
    auth: { ...owner, role: 'cli', hash: 'client', hostId: 'host' },
    hostId: 'host',
    authenticated: true,
    deadline: owner.expires,
    managementMetadata: {
      ...metadata,
      kind: 'client',
      instance: '00000000-0000-4000-8000-000000000001',
    },
  });
  const sockets = [agent, client];
  const ctx = {
    storage,
    getWebSockets: (tag?: string) =>
      sockets.filter(
        (s) =>
          s.readyState < 2 && (!tag || s.deserializeAttachment().role === tag),
      ),
    waitUntil: vi.fn(),
  };
  const relay = new HostRelayDO(
    ctx as unknown as DurableObjectState,
    {} as Env,
  );
  const request = (command?: unknown, auth = owner) =>
    relay.fetch(
      new Request('https://internal/configuration', {
        method: command ? 'POST' : 'GET',
        headers: {
          'x-host': 'host',
          'x-auth': encodeURIComponent(JSON.stringify(auth)),
        },
        ...(command ? { body: JSON.stringify(command) } : {}),
      }),
    );
  return { storage, relay, request, agent, client, sockets };
}
beforeEach(() => {
  vi.mocked(registryCall).mockReset();
  vi.mocked(registryCall).mockImplementation(async (_env, op, data: any) => {
    if (op === 'host') return { id: data.id };
    const hash = data.hash || data.token;
    if (!hash || hash === 'revoked')
      throw new AppError('UNAUTHORIZED', 'Revoked', 401);
    return {
      ...owner,
      hash,
      role: hash === 'owner' ? 'owner' : hash === 'agent' ? 'agent' : 'cli',
      hostId: 'host',
    };
  });
});
describe('remote configuration transport', () => {
  it('only returns online capable targets to current administrators', async () => {
    const h = harness();
    expect((await h.request(undefined, { ...owner, role: 'cli' })).status).toBe(
      403,
    );
    const response = await h.request();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const listed = ((await response.json()) as any).targets;
    expect(listed[0].id).toBe('agent');
    expect(listed[1].id).toMatch(/^client-[a-f0-9]{64}$/);
    const clientTarget = listed[1].id;
    h.client.readyState = 3;
    expect(((await (await h.request()).json()) as any).targets).toHaveLength(1);
    expect(
      (
        await h.request({
          target: clientTarget,
          command: { action: 'read' },
        })
      ).status,
    ).toBe(409);
  });
  it('binds stable client target identities to their credential as well as instance', async () => {
    const h = harness();
    const initial = ((await (await h.request()).json()) as any).targets[1].id;
    const attachment = h.client.deserializeAttachment();
    attachment.auth.hash = 'different-client';
    h.client.serializeAttachment(attachment);
    const changed = ((await (await h.request()).json()) as any).targets[1].id;
    expect(changed).not.toBe(initial);
    expect(
      (await h.request({ target: initial, command: { action: 'read' } }))
        .status,
    ).toBe(409);
    expect(h.client.send).not.toHaveBeenCalled();
  });
  it('binds replies to the selected socket and never stores configuration bodies', async () => {
    const h = harness();
    const response = h.request({
      target: 'agent',
      command: { action: 'read' },
    });
    await vi.waitFor(() => expect(h.agent.send).toHaveBeenCalled());
    const frame = JSON.parse(h.agent.send.mock.calls[0][0]);
    await h.relay.webSocketMessage(
      h.client as unknown as WebSocket,
      JSON.stringify({
        type: 'management-result',
        wire: frame.wire,
        result: { text: 'spoof' },
      }),
    );
    await h.relay.webSocketMessage(
      h.agent as unknown as WebSocket,
      JSON.stringify({
        type: 'management-result',
        wire: frame.wire,
        result: { text: 'secret-configuration', revision: 'f'.repeat(64) },
      }),
    );
    const result = await response;
    expect(result.status).toBe(200);
    expect(((await result.json()) as any).text).toBe('secret-configuration');
    expect(JSON.stringify([...h.storage.values])).not.toContain(
      'secret-configuration',
    );
    expect(JSON.stringify(h.agent.deserializeAttachment())).not.toContain(
      'secret-configuration',
    );
  });
  it('checks administrator authorization again before releasing secrets', async () => {
    const h = harness();
    const response = h.request({
      target: 'agent',
      command: { action: 'read' },
    });
    await vi.waitFor(() => expect(h.agent.send).toHaveBeenCalled());
    const frame = JSON.parse(h.agent.send.mock.calls[0][0]);
    vi.mocked(registryCall).mockImplementation(async (_e, _o, d: any) => ({
      ...owner,
      role: 'cli',
      hash: d.hash,
    }));
    await h.relay.webSocketMessage(
      h.agent as unknown as WebSocket,
      JSON.stringify({
        type: 'management-result',
        wire: frame.wire,
        result: { text: 'secret' },
      }),
    );
    const result = await response;
    expect(result.status).toBe(403);
    expect(await result.text()).not.toContain('secret');
  });
  it('validates bounded UTF-8 payloads, fixed targets, revisions and mutation identities', () => {
    const request = {
      target: 'agent',
      command: {
        action: 'replace',
        requestId: 'once',
        revision: 'f'.repeat(64),
        text: '{}',
      },
    };
    expect(managementRequestSchema.safeParse(request).success).toBe(true);
    expect(
      managementRequestSchema.safeParse({ ...request, path: '/etc/passwd' })
        .success,
    ).toBe(false);
    expect(
      managementRequestSchema.safeParse({
        ...request,
        command: { ...request.command, text: '中'.repeat(22000) },
      }).success,
    ).toBe(false);
    expect(
      managementRequestSchema.safeParse({
        ...request,
        command: { action: 'restart' },
      }).success,
    ).toBe(false);
  });
  it('expires unknown results and only accepts the matching socket', async () => {
    vi.useFakeTimers();
    try {
      const channel = new ManagementRequests();
      const ws = socket({}) as unknown as WebSocket;
      const pending = channel.request(ws, { action: 'read' });
      const rejection = expect(pending).rejects.toMatchObject({
        code: 'RESULT_UNKNOWN',
      });
      await vi.advanceTimersByTimeAsync(20001);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
  it('protects public routes with platform and host scoped credentials', async () => {
    const forward = vi.fn(
      async () =>
        new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    );
    const env = {
      HOSTS: {
        idFromName: (id: string) => id,
        get: () => ({ fetch: forward }),
      },
    } as unknown as Env;
    const get = (path: string, token?: string) =>
      worker.fetch(
        new Request('https://relay.test' + path, {
          headers: {
            ...(token ? { Authorization: 'Bearer ' + token } : {}),
            ...(path.startsWith('/ws/') ? { Upgrade: 'websocket' } : {}),
          },
        }),
        env,
      );
    expect((await get('/api/v1/admin/hosts/host/configuration')).status).toBe(
      401,
    );
    expect(
      (await get('/api/v1/admin/hosts/host/configuration', 'client')).status,
    ).toBe(403);
    expect((await get('/ws/v1/client-management/other', 'client')).status).toBe(
      403,
    );
    expect((await get('/ws/v1/client-management/host', 'owner')).status).toBe(
      403,
    );
    expect(forward).not.toHaveBeenCalled();
    expect(
      (await get('/api/v1/admin/hosts/host/configuration', 'owner')).status,
    ).toBe(200);
    expect(forward).toHaveBeenCalledTimes(1);
  });
});

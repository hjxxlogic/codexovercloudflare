import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from './helpers/do-state.ts';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: unknown,
    ) {
      ctx.getWebSockets ??= () => [];
      ctx.waitUntil ??= () => {};
    }
  },
}));
vi.mock('../apps/relay/src/common.ts', async (original) => ({
  ...(await original<typeof import('../apps/relay/src/common.ts')>()),
  registryCall: vi.fn(),
}));
import { HostRelayDO } from '../apps/relay/src/host.ts';
import { registryCall } from '../apps/relay/src/common.ts';
const auth = {
  hash: 'client',
  role: 'web',
  hostId: 'host',
  expires: Number.MAX_SAFE_INTEGER,
  version: 2,
  name: 'test',
  created: 0,
};
function socket(initial: any) {
  let attachment = structuredClone(initial);
  return {
    readyState: 1,
    deserializeAttachment: () => structuredClone(attachment),
    serializeAttachment: (a: any) => {
      attachment = structuredClone(a);
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
    id: 'agent',
    role: 'agent',
    auth: { ...auth, role: 'agent', hash: 'agent' },
    epoch: 1,
    protocol: 1,
    deadline: Number.MAX_SAFE_INTEGER,
  });
  const sockets = [agent];
  const waiting: Promise<unknown>[] = [];
  const ctx = {
    storage,
    getWebSockets: (tag?: string) =>
      sockets.filter(
        (s) =>
          !tag ||
          (tag === 'agent'
            ? s.deserializeAttachment().role === 'agent'
            : tag === 'session:' + s.deserializeAttachment().sessionId),
      ),
    waitUntil: (p: Promise<unknown>) => waiting.push(p),
  };
  const create = () =>
    new HostRelayDO(ctx as unknown as DurableObjectState, {} as never);
  let relay = create();
  const headers = {
    'x-auth': encodeURIComponent(JSON.stringify(auth)),
    'x-host': 'host',
    'x-coc-async': '1',
  };
  const start = async (action = 'projects', data: any = {}) => {
    const response = await relay.fetch(
      new Request('https://internal/control', {
        method: 'POST',
        headers,
        body: JSON.stringify({ action, data }),
      }),
    );
    return { response, data: (await response.json()) as any };
  };
  const read = async (id: string, as = auth) => {
    const response = await relay.fetch(
      new Request('https://internal/operation/' + id, {
        headers: {
          ...headers,
          'x-auth': encodeURIComponent(JSON.stringify(as)),
        },
      }),
    );
    return { response, data: (await response.json()) as any };
  };
  const reply = async (frame: any, data: any, error?: any) =>
    relay.webSocketMessage(
      agent as unknown as WebSocket,
      JSON.stringify({
        v: 1,
        type: 'result',
        requestId: frame.requestId,
        ...(error ? { error } : { data }),
      }),
    );
  const frames = () => agent.send.mock.calls.map(([raw]) => JSON.parse(raw));
  return {
    storage,
    agent,
    sockets,
    ctx,
    waiting,
    start,
    read,
    reply,
    frames,
    get relay() {
      return relay;
    },
    recreate() {
      relay = create();
    },
  };
}
beforeEach(() => {
  vi.mocked(registryCall)
    .mockReset()
    .mockResolvedValue({ expires: Number.MAX_SAFE_INTEGER });
});
afterEach(() => vi.useRealTimers());
describe('recoverable asynchronous controls', () => {
  it('reads an operation index and all parts in one snapshot while completion replaces them', async () => {
    const h = harness();
    const relay = h.relay as any;
    const before = {
      id: 'snapshot',
      state: 'pending',
      auth,
      expires: Date.now() + 300000,
      data: 'a'.repeat(20000),
    };
    const after = { ...before, state: 'completed', result: 'b'.repeat(100000) };
    await relay.saveOperation(before);
    let started!: () => void, release!: () => void;
    const entering = new Promise<void>((done) => {
      started = done;
    });
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const original = h.storage.get.bind(h.storage);
    let first = true;
    vi.spyOn(h.storage, 'get').mockImplementation(async (key) => {
      const value = await original(key);
      if (key === 'operation:snapshot' && first) {
        first = false;
        started();
        await gate;
      }
      return value;
    });
    const reading = relay.loadOperation('snapshot');
    await entering;
    const writing = relay.saveOperation(after);
    // Allow a writer outside the read transaction to finish during the gap.
    await new Promise<void>((done) => setImmediate(done));
    release();
    expect(await reading).toEqual(before);
    await writing;
    expect(await relay.loadOperation('snapshot')).toEqual(after);
  });
  it('releases a late attachment for a closed controller without reusing its epoch', async () => {
    const h = harness();
    const sessionId = 'host~session';
    const client = socket({
      id: 'connecting',
      auth,
      role: 'web',
      hostId: 'host',
      sessionId,
      authenticated: false,
      deadline: Date.now() + 15000,
    });
    h.sockets.push(client);
    await (h.relay as any).start({
      auth,
      hostId: 'host',
      socketId: 'connecting',
      kind: 'attach',
      stage: 'get',
      action: 'attach',
      data: { sessionId, takeover: false },
    });
    await h.reply(h.frames()[0], { mode: 'web', state: 'ready' });
    const attach = h.frames()[1];
    client.readyState = 3;
    await h.relay.webSocketClose(client as unknown as WebSocket);
    await h.reply(attach, { attached: true });
    expect(h.storage.values.get('lease:' + sessionId).active).toBe(false);
    expect(h.frames()).toContainEqual({
      type: 'detach',
      sessionId,
      epoch: attach.data.epoch,
    });
    expect((await h.relay.reserve(sessionId, false)).epoch).toBeGreaterThan(
      attach.data.epoch,
    );
    expect(client.send).not.toHaveBeenCalled();
  });
  it('reconciles an orphaned non-expiring controller lease with actual sockets', async () => {
    const h = harness();
    h.storage.values.set('lease:host~session', { epoch: 25, active: true });
    expect((await h.relay.reserve('host~session', false)).epoch).toBe(26);
    h.storage.values.set('lease:host~other', {
      epoch: 10,
      active: true,
      expires: Date.now() + 10000,
    });
    await expect(h.relay.reserve('host~other', false)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
  });
  it('ends the handler before Agent responds and restores a scoped result after hibernation', async () => {
    vi.useFakeTimers();
    const h = harness();
    const { response, data } = await h.start();
    expect(response.status).toBe(202);
    expect(vi.getTimerCount()).toBe(0);
    expect((await h.read(data.operationId)).data.state).toBe('pending');
    h.recreate();
    await h.reply(h.frames()[0], [{ id: 'project' }]);
    h.recreate();
    expect((await h.read(data.operationId)).data).toEqual({
      state: 'completed',
      result: [{ id: 'project' }],
    });
    expect(
      (await h.read(data.operationId, { ...auth, hash: 'foreign' })).response
        .status,
    ).toBe(404);
  });
  it('does not deliver an old Agent epoch result to a replacement request', async () => {
    const h = harness();
    const { data } = await h.start();
    h.storage.values.set('agentEpoch', 2);
    await h.reply(h.frames()[0], { old: true });
    expect((await h.read(data.operationId)).data.state).toBe('pending');
    expect(h.agent.close).toHaveBeenCalled();
  });
  it('validates Agent identity before sending and preserves explicit rejection', async () => {
    const h = harness();
    vi.mocked(registryCall).mockImplementation(async (_env, _op, d: any) => {
      if (d.hash === 'agent') throw new Error('revoked');
      return {};
    });
    const failed = await h.start();
    expect(h.frames()).toHaveLength(0);
    expect((await h.read(failed.data.operationId)).data.error.code).toBe(
      'RESULT_UNKNOWN',
    );
    vi.mocked(registryCall).mockResolvedValue({
      expires: Number.MAX_SAFE_INTEGER,
    });
    const started = await h.start();
    await h.reply(h.frames()[0], undefined, {
      code: 'FORBIDDEN',
      message: 'Wrong mode',
    });
    expect((await h.read(started.data.operationId)).data.error.code).toBe(
      'FORBIDDEN',
    );
  });
  it('coalesces concurrent status probes within one credential scope', async () => {
    const h = harness();
    const accepted = await Promise.all(
      Array.from({ length: 20 }, () => h.start('probe')),
    );
    expect(
      new Set(accepted.map((result) => result.data.operationId)).size,
    ).toBe(1);
    expect(h.frames()).toHaveLength(1);
    await h.reply(h.frames()[0], { online: true });
    expect(
      (await h.read(accepted[0].data.operationId)).data.result.online,
    ).toBe(true);
  });
  it('stores large Unicode control data in bounded parts without losing its identity', async () => {
    const h = harness();
    const text = '测'.repeat(60000);
    const request = await h.start('queue', {
      sessionId: 'host~session',
      requestId: 'same-request',
      mode: 'web',
      text,
    });
    await h.reply(h.frames()[0], { mode: 'web', state: 'ready' });
    expect(h.frames()[1].data.text).toBe(text);
    h.recreate();
    await h.reply(h.frames()[1], { state: 'queued' });
    expect((await h.read(request.data.operationId)).data.result.state).toBe(
      'queued',
    );
    for (const [key, value] of h.storage.values)
      if (key.startsWith('part:') || key.startsWith('operation:'))
        expect(
          new TextEncoder().encode(JSON.stringify(value)).length,
        ).toBeLessThan(128 * 1024);
  });
  it('keeps the host capacity bound across recreation', async () => {
    const h = harness();
    for (let i = 0; i < 64; i++)
      expect((await h.start()).response.status).toBe(202);
    h.recreate();
    expect((await h.start()).response.status).toBe(429);
    expect(h.frames()).toHaveLength(64);
  });
  it('fences concurrent takeovers without replacing the old active controller', async () => {
    const h = harness();
    h.storage.values.set('lease:host~session', { epoch: 4, active: true });
    const first = await h.relay.reserve('host~session', true);
    expect(first.epoch).toBe(5);
    await expect(h.relay.reserve('host~session', true)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    expect(h.storage.values.get('lease:host~session')).toMatchObject({
      epoch: 4,
      active: true,
      pending: { epoch: 5 },
    });
    const old = socket({
      ...auth,
      auth,
      role: 'web',
      sessionId: 'host~session',
      epoch: 3,
      authenticated: true,
    });
    await h.relay.webSocketClose(old as unknown as WebSocket);
    expect(h.storage.values.get('lease:host~session').active).toBe(true);
  });
  it('requires negotiation and gives old clients an explicit upgrade error', async () => {
    const h = harness();
    h.agent.serializeAttachment({
      ...h.agent.deserializeAttachment(),
      protocol: undefined,
    });
    const operation = await h.start();
    expect((await h.read(operation.data.operationId)).data.error.code).toBe(
      'AGENT_NEGOTIATING',
    );
    const legacy = await h.relay.fetch(
      new Request('https://internal/control', {
        method: 'POST',
        body: JSON.stringify({ action: 'projects', data: {} }),
      }),
    );
    expect(((await legacy.json()) as any).error.code).toBe('UPGRADE_REQUIRED');
  });
});
describe('flow control and authorization on activity', () => {
  it('retains acknowledgement budgets across object reconstruction', async () => {
    const h = harness(),
      slow = socket({ id: 'reader', history: true });
    h.sockets.push(slow);
    for (let i = 0; i < 1000; i++)
      h.relay.send(slow as unknown as WebSocket, { type: 'event' });
    h.recreate();
    h.relay.send(slow as unknown as WebSocket, { type: 'event' });
    expect(slow.send).toHaveBeenCalledTimes(1000);
    expect(slow.close).toHaveBeenCalledWith(4008, expect.any(String));
  });
  it('invalidates a pending auth check rather than restoring a revoked cache entry', async () => {
    const h = harness();
    let release!: (value: unknown) => void;
    vi.mocked(registryCall).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const results = Promise.allSettled([
      h.relay.authorized('same'),
      h.relay.authorized('same'),
    ]);
    await h.relay.fetch(
      new Request('https://internal/revoke-auth', {
        method: 'POST',
        body: JSON.stringify({ hash: 'same' }),
      }),
    );
    release({ expires: Number.MAX_SAFE_INTEGER });
    expect(
      (await results).every((result) => result.status === 'rejected'),
    ).toBe(true);
    expect(registryCall).toHaveBeenCalledOnce();
  });
  it('does no authorization or periodic scheduling for permanent idle sockets', async () => {
    const h = harness();
    await h.relay.alarm();
    expect(h.storage.alarm).toBeNull();
    expect(registryCall).not.toHaveBeenCalled();
    expect(h.agent.close).not.toHaveBeenCalled();
  });
  it('keeps an unused host empty through status, notifications, and revocation', async () => {
    const h = harness();
    h.sockets.length = 0;
    h.storage.values.clear();
    const writes = vi.spyOn(h.storage, 'put');
    for (const path of ['/status', '/notify', '/revoke-auth']) {
      const response = await h.relay.fetch(
        new Request('https://internal' + path, {
          method: path === '/status' ? 'GET' : 'POST',
          ...(path === '/status'
            ? {}
            : { body: JSON.stringify({ scope: 'release', agent: true }) }),
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(writes).not.toHaveBeenCalled();
    expect(h.storage.values.size).toBe(0);
    expect(h.storage.alarm).toBeNull();
    expect(registryCall).not.toHaveBeenCalled();
  });
  it('cleans an offline ticket exactly at its finite deadline', async () => {
    const h = harness();
    h.sockets.length = 0;
    const at = Date.now() + 60000;
    h.storage.values.set('ticket:test', { expires: at });
    h.storage.values.set(`due:${String(at).padStart(16, '0')}:ticket:test`, {
      key: 'ticket:test',
      at,
    });
    await h.relay.alarm();
    expect(h.storage.alarm).toBe(at);
    vi.useFakeTimers();
    vi.setSystemTime(at);
    await h.relay.alarm();
    expect(h.storage.values.has('ticket:test')).toBe(false);
    expect(h.storage.alarm).toBeNull();
  });
  it('isolates slow recipients while preserving their event order', async () => {
    const h = harness();
    const slow = socket({
        history: true,
        authenticated: true,
        role: 'web',
        auth: { hash: 'slow' },
        deadline: Number.MAX_SAFE_INTEGER,
      }),
      fast = socket({
        history: true,
        authenticated: true,
        role: 'web',
        auth: { hash: 'fast' },
        deadline: Number.MAX_SAFE_INTEGER,
      });
    h.sockets.push(slow, fast);
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(registryCall).mockImplementation(async (_env, _op, d: any) => {
      if (d.hash === 'slow') await block;
      return { expires: Number.MAX_SAFE_INTEGER };
    });
    // All readers subscribe to this session; the Agent epoch is independent.
    for (const ws of [slow, fast])
      ws.serializeAttachment({
        ...ws.deserializeAttachment(),
        sessionId: 'host~session',
      });
    for (const seq of [1, 2])
      await h.relay.webSocketMessage(
        h.agent as unknown as WebSocket,
        JSON.stringify({
          type: 'event',
          sessionId: 'host~session',
          epoch: 1,
          payload: { event: { seq } },
        }),
      );
    await vi.waitFor(() => expect(fast.send).toHaveBeenCalledTimes(2));
    expect(slow.send).not.toHaveBeenCalled();
    release();
    await Promise.all(h.waiting);
    expect(
      slow.send.mock.calls.map(([raw]) => JSON.parse(raw).event.seq),
    ).toEqual([1, 2]);
  });
});

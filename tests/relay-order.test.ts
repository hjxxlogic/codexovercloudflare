import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from './helpers/do-state.ts';
import { SecureChannel } from '../packages/channel/src/secure.ts';
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: any,
      public env: any,
    ) {}
  },
}));
vi.mock('../apps/relay/src/common.ts', async (original) => ({
  ...(await original<typeof import('../apps/relay/src/common.ts')>()),
  registryCall: vi.fn(),
}));
import { HostRelayDO } from '../apps/relay/src/host.ts';
import { registryCall, type Auth } from '../apps/relay/src/common.ts';
const auth = {
  hash: 'a'.repeat(64),
  role: 'web',
  hostId: 'host',
  expires: Number.MAX_SAFE_INTEGER,
  version: 2,
  name: 'client',
  created: 0,
} as Auth;
const policy = createHash('sha256')
  .update(JSON.stringify([null, null, null, null, null]))
  .digest('hex');
function socket(initial: any) {
  let a = {
    policy,
    hostId: 'host',
    deadline: Number.MAX_SAFE_INTEGER,
    ...initial,
  };
  return {
    readyState: 1,
    deserializeAttachment: () => structuredClone(a),
    serializeAttachment: (next: any) => {
      a = structuredClone(next);
    },
    send: vi.fn(),
    close: vi.fn(),
  };
}
function harness(storage = new MemoryStorage()) {
  storage.values.set('channelVersion', 1);
  const agent = socket({
    id: 'agent',
    kind: 'agent',
    auth: { ...auth, role: 'agent', hash: 'agent' },
    bound: true,
  });
  const client = socket({
    id: 'client',
    kind: 'client',
    target: 'agent',
    auth,
  });
  const sockets = [agent, client],
    ctx = { storage, getWebSockets: () => sockets };
  let relay = new HostRelayDO(ctx as any, {} as any);
  const frame = (ws: any, d: any) =>
    relay.webSocketMessage(ws, JSON.stringify(d));
  const fetch = (path = '/authorization-change') =>
    relay.fetch(
      new Request('https://internal' + path, {
        headers: {
          'x-host': 'host',
          'x-coc-authorization-event': 'change',
          'x-auth': encodeURIComponent(
            JSON.stringify({ ...auth, role: 'owner' }),
          ),
        },
      }),
    );
  const frames = (ws = agent) =>
    ws.send.mock.calls.map(([raw]) => JSON.parse(raw));
  const bind = async () => {
    await frame(client, { type: 'channel-connect', key: 'A'.repeat(43) + '=' });
    return client.deserializeAttachment().link;
  };
  return {
    storage,
    agent,
    client,
    sockets,
    frames,
    frame,
    fetch,
    bind,
    restore: () => {
      relay = new HostRelayDO(ctx as any, {} as any);
    },
    relay: () => relay,
  };
}
beforeEach(() => {
  vi.mocked(registryCall)
    .mockReset()
    .mockImplementation(async (_env, op, data: any) =>
      op === 'host'
        ? { id: 'host' }
        : op === 'authHash'
          ? {
              ...auth,
              hash: data.hash,
              role: data.hash === 'agent' ? 'agent' : 'web',
            }
          : {},
    );
});
afterEach(() => vi.useRealTimers());
describe('opaque relay connection routing', () => {
  it('binds only Worker-authenticated identity and forwards arbitrary opaque application records', async () => {
    const h = harness(),
      link = await h.bind();
    expect(h.frames()[0]).toMatchObject({
      type: 'channel-open',
      link,
      identity: {
        owner: auth.hash,
        role: 'web',
        permissions: { access: true, projects: false, configuration: false },
      },
    });
    const calls = vi.mocked(registryCall).mock.calls.length;
    await h.frame(h.client, {
      type: 'channel-header',
      data: 'public-stream-header',
    });
    await h.frame(h.client, { type: 'channel-data', data: 'opaque-record' });
    expect(h.frames().at(-1)).toEqual({
      type: 'channel-data',
      link,
      data: 'opaque-record',
    });
    expect(vi.mocked(registryCall).mock.calls.length).toBe(calls);
    await h.frame(h.agent, {
      type: 'channel-data',
      link,
      data: 'opaque-reply',
    });
    expect(h.frames(h.client).at(-1)).toEqual({
      type: 'channel-data',
      data: 'opaque-reply',
    });
    expect([...h.storage.values.keys()]).toEqual(['channelVersion']);
  });
  it('supports a new endpoint-only method without exposing its Unicode payload or changing Worker', async () => {
    const h = harness(),
      link = await h.bind(),
      binding = h.frames()[0].binding;
    const a = await SecureChannel.create(true, binding),
      b = await SecureChannel.create(false, binding);
    try {
      const ah = a.exchange(b.publicKey),
        bh = b.exchange(a.publicKey);
      a.accept(bh);
      b.accept(ah);
      const text = JSON.stringify({
        method: 'test/endpoint-only-new-method',
        sessionId: 'private-session',
        config: '/private/config',
        text: '机密 🧪',
      });
      await h.frame(h.client, { type: 'channel-data', data: a.seal(text) });
      const forwarded = h.frames().at(-1);
      expect(b.open(forwarded.data)).toBe(text);
      await h.frame(h.agent, {
        type: 'channel-data',
        link,
        data: b.seal('private-reply'),
      });
      expect(a.open(h.frames(h.client).at(-1).data)).toBe('private-reply');
      expect(
        JSON.stringify([
          h.frames(),
          h.frames(h.client),
          [...h.storage.values],
          h.client.deserializeAttachment(),
        ]),
      ).not.toMatch(/private-session|private\/config|机密|private-reply/);
    } finally {
      a.close();
      b.close();
    }
  });
  it('keeps request, response, error and notification markers for every business family out of Worker state', async () => {
    const h = harness(),
      link = await h.bind(),
      binding = h.frames()[0].binding;
    const client = await SecureChannel.create(true, binding),
      agent = await SecureChannel.create(false, binding);
    const a = client.exchange(agent.publicKey),
      b = agent.exchange(client.publicKey);
    client.accept(b);
    agent.accept(a);
    const families = [
      'rpc',
      'prompt',
      'approval',
      'history',
      'external-codex',
      'files',
      'terminal',
      'configuration',
    ];
    const markers = families.map((f) => 'private-' + f + '-不可见');
    try {
      for (const marker of markers) {
        const request = JSON.stringify({
          path: marker,
          sessionId: marker,
          requestId: marker,
          body: { input: marker },
        });
        await h.frame(h.client, {
          type: 'channel-data',
          data: client.seal(request),
        });
        expect(agent.open(h.frames().at(-1).data)).toBe(request);
        for (const type of ['response', 'error', 'notification']) {
          const reply = JSON.stringify({ type, payload: marker });
          await h.frame(h.agent, {
            type: 'channel-data',
            link,
            data: agent.seal(reply),
          });
          expect(client.open(h.frames(h.client).at(-1).data)).toBe(reply);
        }
      }
      const visible = JSON.stringify([
        h.frames(),
        h.frames(h.client),
        h.sockets.map((s) => s.deserializeAttachment()),
        [...h.storage.values],
        vi.mocked(registryCall).mock.calls,
      ]);
      for (const marker of markers) expect(visible).not.toContain(marker);
      expect(visible).not.toContain('secretKey');
      expect([...h.storage.values.keys()]).toEqual(['channelVersion']);
    } finally {
      client.close();
      agent.close();
    }
  });
  it('buffers both directions in order across overlapping permission refreshes', async () => {
    const h = harness(),
      link = await h.bind();
    let release!: (value: any) => void;
    vi.mocked(registryCall).mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const first = h.fetch();
    await vi.waitFor(() => expect(release).toBeDefined());
    const second = h.fetch();
    const incoming = h.frame(h.client, { type: 'channel-data', data: 'one' });
    const next = h.frame(h.client, { type: 'channel-data', data: 'two' });
    const outgoing = h.frame(h.agent, {
      type: 'channel-data',
      link,
      data: 'reply',
    });
    await Promise.resolve();
    expect(h.frames().some((d) => d.data === 'one')).toBe(false);
    release({ ...auth, role: 'agent', hash: 'agent' });
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    await Promise.all([incoming, next, outgoing]);
    expect(
      h
        .frames()
        .filter((d) => d.type === 'channel-data')
        .map((d) => d.data),
    ).toEqual(['one', 'two']);
    expect(h.frames(h.client).at(-1).data).toBe('reply');
    expect(h.agent.deserializeAttachment().retired).not.toBe(true);
  });
  it('closes a paused attachment after DO reconstruction instead of losing queued data', async () => {
    const h = harness();
    await h.bind();
    h.client.serializeAttachment({
      ...h.client.deserializeAttachment(),
      blocked: true,
    });
    h.restore();
    await h.frame(h.client, { type: 'channel-data', data: 'lost-state' });
    expect(h.client.deserializeAttachment().retired).toBe(true);
    expect(h.frames().some((d) => d.data === 'lost-state')).toBe(false);
  });
  it('serializes handshake admission before subsequent frames despite authorization awaits', async () => {
    const h = harness();
    let release!: (value: any) => void;
    vi.mocked(registryCall).mockImplementationOnce(
      () =>
        new Promise((r) => {
          release = r;
        }),
    );
    const first = h.bind();
    await vi.waitFor(() => expect(release).toBeDefined());
    const second = h.frame(h.client, {
      type: 'channel-data',
      data: 'after-handshake',
    });
    release({ id: 'host' });
    await Promise.all([first, second]);
    expect(h.frames().map((d) => d.type)).toEqual([
      'channel-open',
      'channel-data',
    ]);
  });
  it.each(['owner', 'link', 'sessionId'])(
    'rejects a client injecting outer %s routing fields',
    async (field) => {
      const h = harness();
      await h.bind();
      await h.frame(h.client, {
        type: 'channel-data',
        data: 'opaque',
        [field]: 'forged',
      });
      expect(h.client.deserializeAttachment().retired).toBe(true);
      expect(h.frames().filter((d) => d.data === 'opaque')).toHaveLength(0);
    },
  );
  it('does not route a reply from another uplink to the client', async () => {
    const h = harness(),
      link = await h.bind(),
      other = socket({
        id: 'other',
        kind: 'manager',
        auth: { ...auth, role: 'cli' },
        bound: true,
        target: 'another',
      });
    h.sockets.push(other);
    await h.frame(other, { type: 'channel-data', link, data: 'wrong-target' });
    expect(h.frames(h.client)).toHaveLength(0);
  });
  it('rejects generic stream data sent before the handshake', async () => {
    const h = harness();
    await h.frame(h.client, { type: 'channel-data', data: 'opaque' });
    expect(h.client.deserializeAttachment().retired).toBe(true);
    expect(h.frames()).toHaveLength(0);
  });
  it('fences a still OPEN retired socket and notifies the endpoint on close', async () => {
    const h = harness(),
      link = await h.bind();
    await h.relay().webSocketClose(h.client as any);
    expect(h.client.readyState).toBe(1);
    await h.frame(h.client, { type: 'channel-data', data: 'late' });
    expect(h.frames().at(-1)).toEqual({ type: 'channel-close', link });
  });
  it('rejects expiry and frame-byte budget overflow before forwarding', async () => {
    const h = harness();
    await h.bind();
    h.client.serializeAttachment({
      ...h.client.deserializeAttachment(),
      deadline: Date.now() - 1,
    });
    await h.frame(h.client, { type: 'channel-data', data: 'late' });
    expect(h.client.deserializeAttachment().retired).toBe(true);
    const large = harness();
    await large.bind();
    await large.frame(large.client, {
      type: 'channel-data',
      data: 'x'.repeat(256 * 1024),
    });
    expect(large.client.close).toHaveBeenCalledWith(1009, expect.any(String));
  });
  it('closes endpoint routes and their clients together on endpoint replacement', async () => {
    const h = harness();
    await h.bind();
    await h.relay().webSocketClose(h.agent as any);
    expect(h.agent.deserializeAttachment().retired).toBe(true);
    expect(h.client.deserializeAttachment().retired).toBe(true);
  });
  it('returns upgrade errors for old business dispatch and stores no request or result', async () => {
    const h = harness();
    expect((await h.fetch('/control')).status).toBe(426);
    expect([...h.storage.values.keys()]).toEqual(['channelVersion']);
  });
});
describe('authorization retirement confirmation', () => {
  const revokeClient = () => {
    const original = vi.mocked(registryCall).getMockImplementation()!;
    vi.mocked(registryCall).mockImplementation(async (...args) => {
      if (args[1] === 'authHash' && (args[2] as any).hash === auth.hash)
        throw new Error('revoked');
      return original(...args);
    });
  };
  it('preserves an unrelated authorized channel across a credential change', async () => {
    const h = harness();
    await h.bind();
    expect((await h.fetch()).status).toBe(200);
    expect(h.client.close).not.toHaveBeenCalled();
    await h.frame(h.client, { type: 'channel-data', data: 'still-authorized' });
    expect(h.frames().at(-1).data).toBe('still-authorized');
    expect(h.frames().some((d) => d.type === 'channel-retire')).toBe(false);
  });
  it('retires a reduced permission binding even if the credential remains valid', async () => {
    const h = harness();
    await h.bind();
    const a = h.client.deserializeAttachment();
    h.client.serializeAttachment({
      ...a,
      permissions: { ...a.permissions, projects: true },
    });
    const result = h.fetch();
    await vi.waitFor(() =>
      expect(h.frames().some((d) => d.type === 'channel-retire')).toBe(true),
    );
    const d = h.frames().find((d) => d.type === 'channel-retire');
    await h.frame(h.agent, { type: 'channel-retired', event: d.event });
    expect((await result).status).toBe(200);
    expect(h.client.deserializeAttachment().retired).toBe(true);
  });
  it('closes a revoked unregistered uplink without waiting for a business fence', async () => {
    const h = harness();
    h.agent.serializeAttachment({
      ...h.agent.deserializeAttachment(),
      bound: false,
    });
    vi.mocked(registryCall).mockRejectedValue(new Error('revoked'));
    expect((await h.fetch()).status).toBe(200);
    expect(h.agent.close).toHaveBeenCalledWith(4001, 'Connection closed');
    expect(h.frames()).toEqual([]);
    expect(await h.storage.get('retirements')).toEqual([]);
  });
  it('waits for the exact endpoint acknowledgement and blocks late client frames', async () => {
    const h = harness();
    await h.bind();
    revokeClient();
    const result = h.fetch();
    await vi.waitFor(() =>
      expect(h.frames().some((d) => d.type === 'channel-retire')).toBe(true),
    );
    const retirement = h.frames().find((d) => d.type === 'channel-retire');
    await h.frame(h.client, { type: 'channel-data', data: 'late' });
    expect(h.frames().some((d) => d.data === 'late')).toBe(false);
    await h.frame(h.client, {
      type: 'channel-retired',
      event: retirement.event,
    });
    expect(await h.storage.get('retirements')).toHaveLength(1);
    const buffered = h.frame(h.agent, {
      type: 'channel-data',
      link: h.client.deserializeAttachment().link,
      data: 'revoked-reply',
    });
    await h.frame(h.agent, {
      type: 'channel-retired',
      event: retirement.event,
    });
    expect((await result).status).toBe(200);
    await buffered;
    expect(h.frames(h.client).some((d) => d.data === 'revoked-reply')).toBe(
      false,
    );
    expect(await h.storage.get('retirements')).toEqual([]);
  });
  it('keeps missing confirmations across timeout and DO reconstruction, then retries', async () => {
    vi.useFakeTimers();
    const h = harness();
    await h.bind();
    revokeClient();
    const first = h.fetch();
    await vi.waitFor(() =>
      expect(h.frames().some((d) => d.type === 'channel-retire')).toBe(true),
    );
    await vi.advanceTimersByTimeAsync(5001);
    expect((await first).status).toBe(503);
    expect(await h.storage.get('retirements')).toHaveLength(1);
    h.restore();
    const retry = h.fetch();
    await vi.waitFor(() =>
      expect(
        h.frames().filter((d) => d.type === 'channel-retire'),
      ).toHaveLength(2),
    );
    const retirement = h
      .frames()
      .filter((d) => d.type === 'channel-retire')
      .at(-1);
    await h.frame(h.agent, {
      type: 'channel-retired',
      event: retirement.event,
    });
    expect((await retry).status).toBe(200);
  });
  it('requires an endpoint-wide fence even when the endpoint credential itself was revoked', async () => {
    const h = harness();
    await h.bind();
    vi.mocked(registryCall).mockRejectedValue(new Error('revoked'));
    const result = h.fetch();
    await vi.waitFor(() =>
      expect(
        h.frames().some((d) => d.type === 'channel-retire' && d.link === '*'),
      ).toBe(true),
    );
    for (const d of h.frames().filter((d) => d.type === 'channel-retire'))
      await h.frame(h.agent, { type: 'channel-retired', event: d.event });
    expect((await result).status).toBe(200);
    expect(h.agent.deserializeAttachment().retired).toBe(true);
  });
  it('retries a blocked migration on the same object after pending state is reconciled', async () => {
    const storage = new MemoryStorage();
    await storage.put('lease:pending', {
      active: false,
      pending: { epoch: 7 },
    });
    const relay = new HostRelayDO(
      { storage, getWebSockets: () => [] } as any,
      {} as any,
    );
    const request = () => relay.fetch(new Request('https://internal/status'));
    expect((await request()).status).toBe(503);
    expect(await storage.get('channelVersion')).toBeUndefined();
    await storage.put('lease:pending', { active: false });
    expect((await request()).status).toBe(200);
    expect(await storage.get('channelVersion')).toBe(1);
    expect(await storage.get('~opaque-v1:backup:lease:pending')).toEqual({
      active: false,
    });
  });
  it('archives old cloud business journals at the one-way migration boundary', async () => {
    const storage = new MemoryStorage();
    await storage.put({
      'lease:secret-session': { ticket: 'secret-ticket' },
      'operation:private': { body: 'private' },
      wakeUntil: 123,
    });
    const relay = new HostRelayDO(
      { storage, getWebSockets: () => [] } as any,
      {} as any,
    );
    expect(
      (await relay.fetch(new Request('https://internal/status'))).status,
    ).toBe(200);
    expect(await storage.get('wakeUntil')).toBe(123);
    expect(await storage.get('channelVersion')).toBe(1);
    expect(await storage.get('lease:secret-session')).toBeUndefined();
    expect(await storage.get('~opaque-v1:backup:lease:secret-session')).toEqual(
      { ticket: 'secret-ticket' },
    );
    expect(await storage.get('~opaque-v1:backup:operation:private')).toEqual({
      body: 'private',
    });
  });
});

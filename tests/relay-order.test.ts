import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: unknown,
      public env: unknown,
    ) {}
  },
}));
vi.mock('../apps/relay/src/common.ts', async (original) => ({
  ...(await original<typeof import('../apps/relay/src/common.ts')>()),
  registryCall: vi.fn(),
}));

import { HostRelayDO } from '../apps/relay/src/host.ts';
import { registryCall } from '../apps/relay/src/common.ts';

describe('relay stream ordering', () => {
  it('preserves Agent frame order when authorization checks finish out of order', async () => {
    let releaseFirst!: () => void;
    const firstCheck = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let checks = 0;
    vi.mocked(registryCall).mockImplementation(async () => {
      if (++checks === 1) await firstCheck;
      return {};
    });
    const output: unknown[] = [];
    const attachment = {
      role: 'agent',
      auth: { hash: 'agent-hash' },
      epoch: 1,
      deadline: Date.now() + 60000,
    };
    const agent = {
      deserializeAttachment: () => attachment,
    } as unknown as WebSocket;
    const client = {
      deserializeAttachment: () => ({
        role: 'web',
        auth: { hash: 'client-hash' },
        authenticated: true,
        epoch: 1,
      }),
      send: (value: string) => output.push(JSON.parse(value).event.seq),
    };
    const ctx = {
      storage: { get: async () => 1 },
      getWebSockets: () => [client],
    };
    const relay = new HostRelayDO(
      ctx as unknown as DurableObjectState,
      {} as never,
    );
    const frame = (seq: number) =>
      JSON.stringify({
        type: 'event',
        sessionId: 'host~session',
        epoch: 1,
        payload: { type: 'event', event: { seq } },
      });
    const first = relay.webSocketMessage(agent, frame(1));
    const second = relay.webSocketMessage(agent, frame(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const beforeRelease = output.slice();
    // A different connection must still deliver replies while this one waits.
    const otherAgent = {
      deserializeAttachment: () => attachment,
    } as unknown as WebSocket;
    await relay.webSocketMessage(otherAgent, frame(99));
    const independentOutput = output.slice();
    releaseFirst();
    await Promise.all([first, second]);
    expect(beforeRelease).toEqual([]);
    expect(independentOutput).toEqual([99]);
    expect(output).toEqual([99, 1, 2]);
  });
});

describe('read-only history transport', () => {
  it('binds reads to the authenticated session and never acquires a control lease', async () => {
    vi.mocked(registryCall).mockResolvedValue({});
    const output: any[] = [];
    const ws = {
      deserializeAttachment: () => ({
        history: true,
        authenticated: true,
        sessionId: 'host~own',
        role: 'web',
        auth: { hash: 'reader' },
        deadline: Date.now() + 60000,
      }),
      send: (data: string) => output.push(JSON.parse(data)),
      close: vi.fn(),
    } as unknown as WebSocket;
    const storage = { get: vi.fn(), put: vi.fn() };
    const relay = new HostRelayDO(
      { storage } as unknown as DurableObjectState,
      {} as never,
    );
    const command = vi
      .spyOn(relay, 'command')
      .mockResolvedValue({ events: [], more: false });
    await relay.webSocketMessage(
      ws,
      JSON.stringify({
        operation: 'page',
        before: -42,
        requestId: 'read',
        sessionId: 'host~foreign',
        action: 'prompt',
      }),
    );
    expect(command).toHaveBeenCalledWith('history', {
      operation: 'page',
      before: -42,
      sessionId: 'host~own',
    });
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.put).not.toHaveBeenCalled();
    expect(output[0]).toMatchObject({
      type: 'history',
      requestId: 'read',
      events: [],
    });
    await relay.webSocketMessage(
      ws,
      JSON.stringify({
        operation: 'prompt',
        requestId: 'execute',
        text: 'run something',
      }),
    );
    expect(command).toHaveBeenCalledTimes(1);
    expect(ws.close).toHaveBeenCalled();
  });

  it('pushes events to readers independently of the controller epoch and excludes RPC traffic', async () => {
    vi.mocked(registryCall).mockResolvedValue({});
    const output: any[] = [];
    const reader = {
      deserializeAttachment: () => ({
        history: true,
        authenticated: true,
        role: 'cli',
        epoch: 0,
        auth: { hash: 'reader' },
      }),
      send: (data: string) => output.push(JSON.parse(data)),
    };
    const agent = {
      deserializeAttachment: () => ({
        role: 'agent',
        epoch: 7,
        auth: { hash: 'agent' },
        deadline: Date.now() + 60000,
      }),
    } as unknown as WebSocket;
    const relay = new HostRelayDO(
      {
        storage: { get: async () => 7 },
        getWebSockets: () => [reader],
      } as unknown as DurableObjectState,
      {} as never,
    );
    for (const type of ['event', 'rpc'])
      await relay.webSocketMessage(
        agent,
        JSON.stringify({
          type,
          epoch: 7,
          sessionId: 'host~session',
          payload: { type, event: { seq: 5, revision: 9 } },
        }),
      );
    expect(output).toMatchObject([
      { type: 'event', event: { seq: 5, revision: 9 } },
    ]);
    await relay.webSocketClose(reader as unknown as WebSocket);
    expect(output).toHaveLength(1);
  });
});

function leaseHarness(initial = { epoch: 0, active: false }) {
  const records = new Map<string, unknown>([['lease:session', initial]]);
  const tx = {
    get: async (key: string) => structuredClone(records.get(key)),
    put: async (key: string, value: unknown) => {
      records.set(key, structuredClone(value));
    },
  };
  let tail = Promise.resolve();
  const storage = {
    ...tx,
    transaction: (callback: (tx: unknown) => Promise<unknown>) => {
      const next = tail.then(() => callback(tx));
      tail = next.then(
        () => {},
        () => {},
      );
      return next;
    },
  };
  const old = {
    close: vi.fn(),
    deserializeAttachment: () => ({
      authenticated: true,
      epoch: initial.epoch,
      role: 'web',
      sessionId: 'session',
    }),
  };
  const relay = new HostRelayDO(
    {
      storage,
      getWebSockets: () => (initial.active ? [old] : []),
    } as unknown as DurableObjectState,
    {} as never,
  );
  return { relay, records, old };
}
describe('attach lease reservations', () => {
  it('allows exactly one concurrent attach while Agent confirmation is pending', async () => {
    const { relay, records } = leaseHarness();
    let confirm!: (value: unknown) => void;
    vi.spyOn(relay, 'command').mockImplementation(
      () =>
        new Promise((resolve) => {
          confirm = resolve;
        }),
    );
    const first = relay.acquire('session', false);
    await vi.waitFor(() => expect(confirm).toBeTypeOf('function'));
    await expect(relay.acquire('session', false)).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    confirm({ ok: true });
    await expect(first).resolves.toBe(1);
    expect(records.get('lease:session')).toMatchObject({
      epoch: 1,
      active: true,
    });
  });
  it('preserves the old controller when the Agent rejects takeover', async () => {
    const { relay, records, old } = leaseHarness({ epoch: 4, active: true });
    vi.spyOn(relay, 'command').mockRejectedValue(new Error('unsupported'));
    await expect(relay.acquire('session', true)).rejects.toThrow('unsupported');
    expect(old.close).not.toHaveBeenCalled();
    expect(records.get('lease:session')).toEqual({ epoch: 4, active: true });
  });
  it('ignores a late close from the replaced controller', async () => {
    const { relay, records, old } = leaseHarness({ epoch: 4, active: true });
    vi.spyOn(relay, 'command').mockResolvedValue({ ok: true });
    await relay.acquire('session', true);
    await relay.webSocketClose(old as unknown as WebSocket);
    expect(records.get('lease:session')).toMatchObject({
      epoch: 5,
      active: true,
    });
  });
});

describe('relay capacity and negotiation', () => {
  it('requires protocol negotiation before forwarding side effects', async () => {
    const send = vi.fn();
    const agent = {
      readyState: 1,
      send,
      deserializeAttachment: () => ({ role: 'agent' }),
    };
    const relay = new HostRelayDO(
      { getWebSockets: () => [agent] } as unknown as DurableObjectState,
      {} as never,
    );
    await expect(
      relay.command('create', {
        key: 'request',
        projectId: 'project',
        mode: 'web',
      }),
    ).rejects.toMatchObject({ code: 'AGENT_NEGOTIATING' });
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects excess pending controls before allocating another timer', async () => {
    const send = vi.fn();
    const agent = {
      readyState: 1,
      send,
      deserializeAttachment: () => ({ role: 'agent', protocol: 1 }),
    };
    const relay = new HostRelayDO(
      { getWebSockets: () => [agent] } as unknown as DurableObjectState,
      {} as never,
    );
    for (let i = 0; i < 64; i++)
      relay.pending.set(String(i), {
        resolve: () => {},
        reject: () => {},
        timer: undefined as never,
      });
    await expect(
      relay.command('get', { sessionId: 'host~session' }),
    ).rejects.toMatchObject({ code: 'BACKPRESSURE' });
    expect(send).not.toHaveBeenCalled();
    expect(relay.pending.size).toBe(64);
  });
  it('closes a reader without acknowledgements and preserves other readers', () => {
    const reader = () => ({
      deserializeAttachment: () => ({ history: true }),
      send: vi.fn(),
      close: vi.fn(),
    });
    const slow = reader(),
      healthy = reader();
    const relay = new HostRelayDO({} as DurableObjectState, {} as never);
    for (let i = 0; i <= 1000; i++)
      relay.send(slow as unknown as WebSocket, {
        type: 'event',
        event: { seq: i },
      });
    expect(slow.send).toHaveBeenCalledTimes(1000);
    expect(slow.close).toHaveBeenCalledWith(4008, expect.any(String));
    relay.send(healthy as unknown as WebSocket, { type: 'event' });
    expect(healthy.send).toHaveBeenCalledOnce();
    expect(healthy.close).not.toHaveBeenCalled();
  });
});

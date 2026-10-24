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
    expect(output).toEqual([{ type: 'event', event: { seq: 5, revision: 9 } }]);
    await relay.webSocketClose(reader as unknown as WebSocket);
    expect(output).toHaveLength(1);
  });
});

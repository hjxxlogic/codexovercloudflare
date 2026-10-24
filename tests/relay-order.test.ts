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

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  observe,
  recoverNotifications,
} from '../apps/web/src/notifications.ts';

class Socket {
  static CLOSING = 2;
  static instances: Socket[] = [];
  readyState = 0;
  onmessage?: (event: { data: string }) => void;
  onclose?: (event: { code: number }) => void;
  send = vi.fn();
  // A stalled close handshake intentionally produces no onclose callback.
  close = vi.fn(() => {
    this.readyState = 2;
  });
  constructor() {
    Socket.instances.push(this);
  }
  message(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}
const stops: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('location', new URL('https://relay.test/'));
});
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each([0, 1])(
  'recovers an unconfirmed notification socket in state %s',
  async (state) => {
    const listener = vi.fn();
    stops.push(observe('/ws/v1/hosts/host', listener));
    const first = Socket.instances[0];
    first.readyState = state;
    await vi.advanceTimersByTimeAsync(16000);
    expect(first.close).toHaveBeenCalledOnce();
    expect(Socket.instances).toHaveLength(2);
    first.message({ type: 'subscribed' });
    expect(listener).not.toHaveBeenCalledWith({ type: 'subscribed' });
    Socket.instances[1].message({ type: 'subscribed', revision: 7 });
    await vi.advanceTimersByTimeAsync(60000);
    expect(Socket.instances).toHaveLength(2);
    expect(listener).toHaveBeenCalledWith({ type: 'subscribed', revision: 7 });
  },
);
it('bounds failed handshakes and permits explicit recovery without duplicate timers', async () => {
  stops.push(observe('/ws/v1/hosts/host', vi.fn()));
  await vi.advanceTimersByTimeAsync(120000);
  expect(Socket.instances).toHaveLength(4);
  recoverNotifications(true);
  const current = Socket.instances.at(-1)!;
  current.message({ type: 'subscribed' });
  await vi.advanceTimersByTimeAsync(60000);
  expect(Socket.instances).toHaveLength(5);
});
it('does not reconnect revoked subscriptions or released listeners', async () => {
  const stop = observe('/ws/v1/hosts/host', vi.fn());
  stops.push(stop);
  Socket.instances[0].onclose?.({ code: 4001 });
  await vi.advanceTimersByTimeAsync(60000);
  expect(Socket.instances).toHaveLength(1);
  recoverNotifications(true);
  stop();
  await vi.advanceTimersByTimeAsync(60000);
  expect(Socket.instances).toHaveLength(2);
});

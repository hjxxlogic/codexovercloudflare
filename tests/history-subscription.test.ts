import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistorySubscription } from '../apps/web/src/history-subscription.ts';
function harness() {
  const records = new Map<string, any>();
  const cache = {
    durableRevision: 0 as number | undefined,
    updateRecord: vi.fn(
      async (key: string, update: (previous: unknown) => any) => {
        const value = update(structuredClone(records.get(key)));
        records.set(key, structuredClone(value));
        return value;
      },
    ),
  };
  const sent: any[] = [];
  const dirty = vi.fn(),
    ready = vi.fn(),
    failure = vi.fn();
  const create = () =>
    HistorySubscription.create(cache, 'subscription', dirty, ready, failure);
  const send = (frame: unknown) => sent.push(frame);
  const window = (frame: any, received = 0, maximum = 10) => ({
    type: 'history-window',
    requestId: frame.requestId,
    stream: frame.stream,
    instance: frame.instance,
    exchangeId: frame.exchangeId,
    agentInstance: 'agent-storage',
    streamSerial: 1,
    creditGeneration: 'credit',
    receivedRevision: received,
    maxRevision: maximum,
  });
  return { cache, records, sent, dirty, ready, failure, create, send, window };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('persistent history subscriber', () => {
  it('replaces an expired subscription without discarding local history or freezing', async () => {
    const h = harness(),
      c = await h.create();
    h.cache.durableRevision = 10;
    await c.connect(h.send);
    const previous = h.sent.at(-1);
    await c.handle({
      type: 'error',
      requestId: previous.requestId,
      error: {
        code: 'HISTORY_SUBSCRIPTION_EXPIRED',
        message: 'retention deadline',
      },
    });
    const replacement = h.sent.at(-1);
    expect(replacement.stream).not.toBe(previous.stream);
    expect(replacement.acknowledgedRevision).toBe(0);
    expect(replacement.receivedRevision).toBe(10);
    expect(h.cache.durableRevision).toBe(10);
    await c.handle(h.window(replacement, 0, 10));
    expect(h.failure).not.toHaveBeenCalled();
    expect(h.ready).toHaveBeenCalledOnce();
    c.stop();
  });
  it('releases only durable history and reconciles a previous ACK without adding a request identity', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    const open = h.sent.at(-1);
    expect(open.releasedRevision).toBeUndefined();
    await c.handle({ ...h.window(open), releasedRevision: 0 });
    await c.commit();
    expect(h.sent.at(-1)).toEqual(open);
    h.cache.durableRevision = 10;
    await c.commit();
    const ack = h.sent.at(-1);
    expect(ack.releasedRevision).toBe(10);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sent.at(-1)).toEqual(ack);
    await c.handle({ ...h.window(ack, 10), releasedRevision: 10 });
    c.disconnect();
    await c.connect(h.send);
    const reopened = h.sent.at(-1);
    expect(reopened.releasedRevision).toBeUndefined();
    await c.handle({ ...h.window(reopened, 10), releasedRevision: 0 });
    expect(h.sent.at(-1)).toMatchObject({
      operation: 'ack',
      receivedRevision: 10,
      releasedRevision: 10,
    });
    await c.handle({ ...h.window(h.sent.at(-1), 10), releasedRevision: 10 });
    const count = h.sent.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.sent).toHaveLength(count);
    c.stop();
  });

  it('keeps the same pending release and backoff when a window acknowledges data only', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    await c.handle({ ...h.window(h.sent.at(-1)), releasedRevision: 0 });
    h.cache.durableRevision = 10;
    await c.commit();
    const ack = h.sent.at(-1);
    const count = h.sent.length;
    for (let i = 0; i < 50; i++)
      await c.handle({ ...h.window(ack, 10), releasedRevision: 0 });
    expect(h.sent).toHaveLength(count);
    expect(h.failure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.sent.at(-1)).toMatchObject({
      requestId: ack.requestId,
      receivedRevision: 10,
      releasedRevision: 10,
    });
    await c.handle({ ...h.window(ack, 10), releasedRevision: 10 });
    const settled = h.sent.length;
    await vi.advanceTimersByTimeAsync(120000);
    expect(h.sent).toHaveLength(settled);
    c.stop();
  });

  it('retries a lost OPEN and ACK indefinitely at a bounded slow rate, then becomes idle', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    const opening = h.sent.at(-1);
    await vi.advanceTimersByTimeAsync(200000);
    expect(h.sent.length).toBeGreaterThan(6);
    expect(
      h.sent.every(
        (frame) => JSON.stringify(frame) === JSON.stringify(opening),
      ),
    ).toBe(true);
    await c.handle(h.window(opening));
    expect(h.ready).toHaveBeenCalledOnce();
    expect(h.dirty).toHaveBeenCalledWith(10);
    await c.commit();
    expect(h.sent.at(-1)).toEqual(opening);
    // In-memory rendering and observing a head do not grant an ACK.
    h.cache.durableRevision = 10;
    await c.commit();
    const ack = h.sent.at(-1);
    expect(ack.operation).toBe('ack');
    expect(ack.receivedRevision).toBe(10);
    await vi.advanceTimersByTimeAsync(150000);
    expect(h.sent.at(-1)).toEqual(ack);
    await c.handle(h.window(ack, 10));
    const count = h.sent.length;
    await vi.advanceTimersByTimeAsync(240000);
    expect(h.sent).toHaveLength(count);
    expect(h.records.get('subscription').acknowledgedRevision).toBe(10);
    c.stop();
  });
  it('binds recovery to the current exchange and freezes a current authoritative rollback', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    const retired = h.sent.at(-1);
    c.disconnect();
    await c.connect(h.send);
    await c.handle(h.window(retired));
    expect(h.ready).not.toHaveBeenCalled();
    const current = h.sent.at(-1);
    await c.handle(h.window(current));
    h.cache.durableRevision = 10;
    await c.commit();
    await c.handle(h.window(h.sent.at(-1), 10));
    c.disconnect();
    await c.connect(h.send);
    await c.handle(h.window(h.sent.at(-1), 9));
    expect(h.failure).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('回退') }),
    );
    const count = h.sent.length;
    await vi.advanceTimersByTimeAsync(240000);
    expect(h.sent).toHaveLength(count);
  });
  it('ignores online old ACKs, recovers a lost last live event from a dirty hint, and never ACKs beyond an announcement', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    const opening = h.sent.at(-1);
    await c.handle(h.window(opening));
    h.cache.durableRevision = 10;
    await c.commit();
    const ack = h.sent.at(-1);
    await c.handle(h.window(ack, 10));
    await c.handle(h.window(ack, 5));
    expect(h.failure).not.toHaveBeenCalled();
    expect(h.records.get('subscription').acknowledgedRevision).toBe(10);
    const hint = { ...h.window(opening, 10, 20), type: 'history-dirty' };
    await c.handle(hint);
    expect(h.dirty).toHaveBeenLastCalledWith(20);
    h.cache.durableRevision = 30;
    await c.commit();
    expect(h.sent.at(-1).receivedRevision).toBe(20);
    c.stop();
  });
  it('persists allocation before use and stops when the checkpoint write fails', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    h.cache.updateRecord.mockRejectedValueOnce(new Error('quota full'));
    await c.handle(h.window(h.sent.at(-1)));
    expect(h.failure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'quota full' }),
    );
    expect(h.ready).not.toHaveBeenCalled();
    h.cache.durableRevision = 10;
    await c.commit();
    expect(h.sent).toHaveLength(1);
  });
  it('does not call a newer concurrent cache commit a rollback of an older OPEN snapshot', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    h.cache.durableRevision = 20;
    await c.handle(h.window(h.sent[0], 0, 10));
    expect(h.failure).not.toHaveBeenCalled();
    expect(h.sent.at(-1).receivedRevision).toBe(10);
    c.stop();
  });
  it('freezes after another tab clears the reader and cannot resurrect it from a delayed window', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    const opening = h.sent.at(-1);
    await c.handle(h.window(opening));
    h.records.delete('subscription');
    h.cache.durableRevision = 10;
    const count = h.sent.length;
    await c.commit();
    expect(h.failure).toHaveBeenCalledOnce();
    await c.handle(h.window(opening));
    await vi.advanceTimersByTimeAsync(240000);
    expect(h.sent).toHaveLength(count);
    expect(h.records.has('subscription')).toBe(false);
    const replacement = await h.create();
    await replacement.connect(h.send);
    expect(h.sent.at(-1).stream).not.toBe(opening.stream);
    replacement.stop();
  });
  it('cannot recreate a cleared reader when an OPEN response was already in flight', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    const opening = h.sent.at(-1);
    h.records.clear();
    await c.handle(h.window(opening));
    expect(h.ready).not.toHaveBeenCalled();
    expect(h.failure).toHaveBeenCalledOnce();
    expect(h.records.size).toBe(0);
  });
  it('restores the same reader identity across reload and rejects local data loss before opening', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    const first = h.sent.at(-1);
    await c.handle(h.window(first));
    h.cache.durableRevision = 10;
    await c.commit();
    await c.handle(h.window(h.sent.at(-1), 10));
    c.stop();
    const next = await h.create();
    await next.connect(h.send);
    expect(h.sent.at(-1).instance).toBe(first.instance);
    expect(h.sent.at(-1).stream).toBe(first.stream);
    expect(h.sent.at(-1).acknowledgedRevision).toBe(10);
    next.stop();
    h.cache.durableRevision = undefined;
    await expect(h.create()).rejects.toThrow('回退');
  });
  it.each(['agentInstance', 'streamSerial', 'creditGeneration'] as const)(
    'rejects a changed %s during current recovery',
    async (field) => {
      const h = harness(),
        c = await h.create();
      await c.connect(h.send);
      await c.handle(h.window(h.sent.at(-1)));
      c.disconnect();
      await c.connect(h.send);
      const changed = h.window(h.sent.at(-1));
      Object.assign(changed, {
        [field]: field === 'streamSerial' ? 2 : 'replaced',
      });
      await c.handle(changed);
      expect(h.failure).toHaveBeenCalledOnce();
    },
  );
  it('rejects a response beyond the checkpoint actually published to the Agent', async () => {
    const h = harness(),
      c = await h.create();
    await c.connect(h.send);
    const opening = h.sent.at(-1);
    await c.handle(h.window(opening));
    h.cache.durableRevision = 20;
    await c.commit();
    expect(h.sent.at(-1).receivedRevision).toBe(10);
    await c.handle(h.window(h.sent.at(-1), 15, 20));
    expect(h.failure).toHaveBeenCalledOnce();
    expect(h.records.get('subscription').acknowledgedRevision).toBe(0);
  });
});

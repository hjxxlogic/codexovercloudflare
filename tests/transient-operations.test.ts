import { afterEach, expect, it, vi } from 'vitest';
import { TransientOperations } from '../apps/relay/src/transient-operations.ts';
import { MAX_QUEUE } from '../packages/protocol/src/index.ts';
const operation = (id: string, wire = id, extra = '') => ({
  id,
  wire,
  state: 'pending',
  expires: Date.now() + 20000,
  extra,
});
afterEach(() => vi.useRealTimers());
it('keeps forwarding correlations only in the current object and retires old wires', () => {
  const live = new TransientOperations<ReturnType<typeof operation>>();
  live.save(operation('one', 'old'));
  live.save(operation('one', 'new'));
  expect(live.wire('old')).toBeUndefined();
  expect(live.wire('new')).toBe('one');
  const read = live.get('one')!;
  read.extra = 'cannot change live state';
  expect(live.get('one')!.extra).toBe('');
  expect(new TransientOperations().get('one')).toBeUndefined();
  live.save({ ...operation('one', 'new'), state: 'completed' });
  expect(live.wire('new')).toBeUndefined();
});
it('expires lost replies without a persistent alarm or retransmission', () => {
  vi.useFakeTimers();
  const live = new TransientOperations<ReturnType<typeof operation>>();
  live.save(operation('one'));
  vi.advanceTimersByTime(20001);
  expect(live.wire('one')).toBeUndefined();
  expect(live.get('one')).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});
it('bounds both count and bytes and preserves a pending request if a replacement exceeds budget', () => {
  const live = new TransientOperations<ReturnType<typeof operation>>();
  for (let i = 0; i < 128; i++) live.save(operation('request-' + i));
  expect(() => live.save(operation('overflow'))).toThrow('budget');
  live.delete('request-0');
  live.save(operation('overflow'));
  expect(() =>
    live.save(operation('request-1', 'replacement', 'x'.repeat(MAX_QUEUE))),
  ).toThrow('budget');
  expect(live.wire('request-1')).toBe('request-1');
  expect(live.wire('replacement')).toBeUndefined();
});

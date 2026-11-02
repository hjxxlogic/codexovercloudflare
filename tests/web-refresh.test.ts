import { afterEach, expect, it, vi } from 'vitest';
import {
  boundedRefresh,
  requestErrorMessage,
} from '../apps/web/src/refresh.ts';
afterEach(() => vi.useRealTimers());
it('releases a stalled refresh and aborts its remaining stages at the total deadline', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  const nextStage = vi.fn();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const work = boundedRefresh(async (current) => {
    signal = current;
    await pending;
    current.throwIfAborted();
    nextStage();
  });
  const failed = expect(work).rejects.toThrow('刷新超时');
  await vi.advanceTimersByTimeAsync(20000);
  await failed;
  expect(signal.aborted).toBe(true);
  release();
  await Promise.resolve();
  expect(nextStage).not.toHaveBeenCalled();
});
it('cancels its deadline after a successful refresh', async () => {
  vi.useFakeTimers();
  let signal!: AbortSignal;
  await boundedRefresh(async (current) => {
    signal = current;
  });
  await vi.advanceTimersByTimeAsync(60000);
  expect(signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
it('hides intentional cancellation while retaining useful timeout and server errors', () => {
  expect(
    requestErrorMessage(
      new DOMException('signal is aborted without reason', 'AbortError'),
    ),
  ).toBeUndefined();
  expect(
    requestErrorMessage(new DOMException('signal timed out', 'TimeoutError')),
  ).toBe('请求超时，请刷新重试。');
  expect(requestErrorMessage(new Error('FORBIDDEN'))).toBe('FORBIDDEN');
  expect(requestErrorMessage(new TypeError('Failed to fetch'))).toContain(
    '未确认的任务已保留',
  );
  expect(
    requestErrorMessage(new Error('STALE_AGENT: Agent replaced')),
  ).toContain('恢复连接');
  expect(requestErrorMessage(new TypeError('Programming error'))).toBe(
    'Programming error',
  );
});

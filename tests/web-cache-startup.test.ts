import { afterEach, expect, it, vi } from 'vitest';
import { HistoryCache } from '../apps/web/src/history.ts';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('bounds a silent IndexedDB open and closes a database that arrives after timeout', async () => {
  vi.useFakeTimers();
  const request: any = { result: { close: vi.fn() } };
  vi.stubGlobal('indexedDB', { open: () => request });
  const cache = new HistoryCache('startup');
  const read = cache.record('catalog').catch((error) => error);
  await vi.advanceTimersByTimeAsync(5000);
  expect(await read).toBeInstanceOf(Error);
  request.onsuccess();
  expect(request.result.close).toHaveBeenCalledOnce();
  cache.close();
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, retryable } from '../apps/web/src/api.ts';
afterEach(() => vi.unstubAllGlobals());
describe('browser request recovery', () => {
  it('retains a stable mutation identity and applies a deadline', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', fetch);
    await api('/sessions', { mode: 'web' }, undefined, 'same-request');
    const options = fetch.mock.calls[0][1];
    expect(options.headers['Idempotency-Key']).toBe('same-request');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it('retries temporary HTML gateway failures and timeout, but preserves unknown results', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>gateway unavailable</html>', { status: 503 }),
        ),
    );
    let error: unknown;
    try {
      await api('/sessions');
    } catch (caught) {
      error = caught;
    }
    expect(retryable(error)).toBe(true);
    expect(retryable(new DOMException('deadline', 'TimeoutError'))).toBe(true);
    expect(retryable(new ApiError('RESULT_UNKNOWN', 'Query first', 504))).toBe(
      false,
    );
    expect(retryable(new ApiError('UNAUTHORIZED', 'Log in', 401))).toBe(false);
  });
});

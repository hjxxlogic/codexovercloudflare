import { afterEach, describe, expect, it, vi } from 'vitest';
import * as notifications from '../apps/web/src/notifications.ts';
import { api, ApiError, retryable } from '../apps/web/src/api.ts';
const response = (value: unknown, init: ResponseInit = {}) =>
  Response.json(value, { ...init, headers: { 'X-CoC-Demand': '1' } });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('browser request recovery', () => {
  it.each([
    ['/', '/api/v1/auth/email'],
    ['/guest/', '/guest/api/v1/auth/email'],
    ['/guest-other', '/api/v1/auth/email'],
  ])('uses the matching API namespace at %s', async (pathname, expected) => {
    vi.stubGlobal('location', new URL('https://relay.test' + pathname));
    const fetch = vi.fn().mockResolvedValue(response({ enabled: false }));
    vi.stubGlobal('fetch', fetch);
    await api('/auth/email');
    expect(fetch.mock.calls[0][0]).toBe(expected);
  });
  it('retains a stable mutation identity and applies a deadline', async () => {
    const fetch = vi.fn().mockResolvedValue(response({}));
    vi.stubGlobal('fetch', fetch);
    await api('/sessions', { mode: 'web' }, undefined, 'same-request');
    const options = fetch.mock.calls[0][1];
    expect(options.headers['Idempotency-Key']).toBe('same-request');
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
  it.each([429, 500, 502, 503, 504, 520, 522, 524])(
    'preserves HTML HTTP %s failures without reporting lost email authentication',
    async (status) => {
      const fetch = vi.fn().mockResolvedValue(
        new Response('<html>temporarily unavailable</html>', {
          status,
          headers: { 'Content-Type': 'text/html; charset=UTF-8' },
        }),
      );
      vi.stubGlobal('fetch', fetch);
      const error = await api('/auth/email').catch((error) => error);
      expect(error).toBeInstanceOf(ApiError);
      expect(error.code).toBe('HTTP_ERROR');
      expect(error.status).toBe(status);
      expect(retryable(error)).toBe(true);
      expect(fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([200, 401, 403])(
    'still requires authentication for an HTML login response with HTTP %s',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response('<html>Cloudflare Access login</html>', {
            status,
            headers: { 'Content-Type': 'text/html' },
          }),
        ),
      );
      await expect(api('/auth/email')).rejects.toMatchObject({
        code: 'ACCESS_REQUIRED',
        status: 401,
      });
    },
  );
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

describe('asynchronous browser result recovery', () => {
  it('handles a completion notification while an earlier snapshot is still loading', async () => {
    let listener!: (event: any) => void;
    const stop = vi.fn();
    vi.spyOn(notifications, 'observe').mockImplementation((_path, callback) => {
      listener = callback;
      return stop;
    });
    let release!: (response: Response) => void;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          { accepted: true, hostId: 'host', operationId: 'operation' },
          { status: 202 },
        ),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValueOnce(
        response({ state: 'completed', result: { online: true } }),
      )
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', fetch);
    const result = api('/hosts/host/probe', {});
    await vi.waitFor(() => expect(listener).toBeTypeOf('function'));
    listener({ type: 'subscribed' });
    listener({ type: 'change', operationId: 'operation' });
    release(response({ state: 'pending' }));
    await expect(result).resolves.toEqual({ online: true });
    expect(stop).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  it('finishes bounded receipt recovery without resubmitting the command', async () => {
    vi.useFakeTimers();
    let listener!: (event: any) => void;
    const stop = vi.fn();
    vi.spyOn(notifications, 'observe').mockImplementation((_path, callback) => {
      listener = callback;
      return stop;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          { accepted: true, hostId: 'host', operationId: 'operation' },
          { status: 202 },
        ),
      )
      .mockImplementation(async () => response({ state: 'pending' }));
    vi.stubGlobal('fetch', fetch);
    const result = api('/sessions', { mode: 'web' }, undefined, 'original-id');
    const failure = expect(result).rejects.toMatchObject({
      code: 'RESULT_UNKNOWN',
    });
    await vi.advanceTimersByTimeAsync(0);
    listener({ type: 'subscribed' });
    await vi.advanceTimersByTimeAsync(30000);
    await failure;
    const count = fetch.mock.calls.length;
    expect(count).toBeLessThan(22);
    expect(
      fetch.mock.calls.filter(([, init]) => init.method === 'POST'),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(86400000);
    expect(fetch).toHaveBeenCalledTimes(count);
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe('Relay compatibility negotiation', () => {
  it('requires an explicit demand-v1 marker from successful older control endpoints', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ id: 'legacy-session' })),
    );
    await expect(api('/sessions', { mode: 'web' })).rejects.toMatchObject({
      code: 'UPGRADE_REQUIRED',
    });
  });
});

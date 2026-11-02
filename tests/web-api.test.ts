import { afterEach, describe, expect, it, vi } from 'vitest';
import * as notifications from '../apps/web/src/notifications.ts';
import { api, queryApi, ApiError, retryable } from '../apps/web/src/api.ts';
const response = (value: unknown, init: ResponseInit = {}) =>
  Response.json(value, {
    ...init,
    headers: { 'X-CoC-Demand': '1', 'X-CoC-Delivery': '2' },
  });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('browser request recovery', () => {
  it.each([
    new TypeError('Failed to fetch'),
    new ApiError('STALE_AGENT', 'Agent replaced', 409),
  ])(
    'recovers a read after a transient connection failure: %s',
    async (error) => {
      vi.useFakeTimers();
      const fetcher = vi
        .fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue(response({ recovered: true }));
      vi.stubGlobal('fetch', fetcher);
      const reading = queryApi('/hosts/host/files');
      await vi.advanceTimersByTimeAsync(600);
      await expect(reading).resolves.toEqual({ recovered: true });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(
        fetcher.mock.calls.every(([, init]) => init.method === 'GET'),
      ).toBe(true);
    },
  );
  it('commits a proved original result before acknowledging its forwarding correlation', async () => {
    vi.spyOn(notifications, 'observe').mockReturnValue(() => {});
    let release!: () => void;
    const committed = new Promise<void>((done) => {
      release = done;
    });
    const proof = {
      requestId: 'original',
      instance: 'agent-store',
      owner: 'a'.repeat(64),
    };
    const commit = vi.fn().mockReturnValue(committed);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          { accepted: true, hostId: 'host', operationId: 'delivery_write' },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        response({
          state: 'completed',
          result: { id: 'host~original' },
          intent: proof,
        }),
      )
      .mockResolvedValueOnce(response({ ok: true }));
    vi.stubGlobal('fetch', fetcher);
    const result = api(
      '/sessions',
      { mode: 'web' },
      undefined,
      'original',
      undefined,
      { instance: 'agent-store', owner: proof.owner, commit },
    );
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(commit).toHaveBeenCalledWith(
      { data: { id: 'host~original' } },
      proof,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].headers).toMatchObject({
      'Idempotency-Key': 'original',
      'X-CoC-Operation-Instance': 'agent-store',
    });
    release();
    await expect(result).resolves.toEqual({ id: 'host~original' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it.each([
    undefined,
    { requestId: 'original', instance: 'other-store', owner: 'a'.repeat(64) },
    { requestId: 'original', instance: 'agent-store', owner: 'b'.repeat(64) },
  ])(
    'does not commit or acknowledge an unproved original result %j',
    async (intent) => {
      vi.spyOn(notifications, 'observe').mockReturnValue(() => {});
      const commit = vi.fn();
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          response(
            { accepted: true, hostId: 'host', operationId: 'delivery_write' },
            { status: 202 },
          ),
        )
        .mockResolvedValueOnce(
          response({
            state: 'completed',
            result: { id: 'host~original' },
            ...(intent ? { intent } : {}),
          }),
        );
      vi.stubGlobal('fetch', fetcher);
      await expect(
        api('/sessions', {}, undefined, 'original', undefined, {
          instance: 'agent-store',
          owner: 'a'.repeat(64),
          commit,
        }),
      ).rejects.toMatchObject({
        code: intent ? 'DELIVERY_STATE_MISMATCH' : 'RESULT_UNKNOWN',
      });
      expect(commit).not.toHaveBeenCalled();
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it('commits a durable business error but preserves a failed local commit without acknowledgment', async () => {
    vi.spyOn(notifications, 'observe').mockReturnValue(() => {});
    const proof = {
      requestId: 'original',
      instance: 'agent-store',
      owner: 'a'.repeat(64),
    };
    const terminal = {
      code: 'RESULT_UNKNOWN',
      message: 'Execution outcome is unknown',
    };
    const fetcher = vi.fn().mockImplementation(async (_path, init) => {
      if (_path.includes('/operations/') && init.method === 'POST')
        return response({ ok: true });
      if (init.method === 'POST')
        return response(
          { accepted: true, hostId: 'host', operationId: 'delivery_write' },
          { status: 202 },
        );
      return response({ state: 'completed', error: terminal, intent: proof });
    });
    vi.stubGlobal('fetch', fetcher);
    const commit = vi.fn().mockResolvedValue(undefined);
    await expect(
      api('/sessions', {}, undefined, 'original', undefined, {
        instance: proof.instance,
        owner: proof.owner,
        commit,
      }),
    ).rejects.toMatchObject({ code: terminal.code });
    expect(commit).toHaveBeenCalledWith({ error: terminal }, proof);
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher.mockClear();
    commit.mockRejectedValue(new Error('Local disk failed'));
    await expect(
      api('/sessions', {}, undefined, 'original', undefined, {
        instance: proof.instance,
        owner: proof.owner,
        commit,
      }),
    ).rejects.toThrow('Local disk failed');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('repeats a read-only POST after a lost relay correlation and stops after success', async () => {
    vi.useFakeTimers();
    vi.spyOn(notifications, 'observe').mockReturnValue(() => {});
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        response(
          { accepted: true, hostId: 'host', operationId: 'delivery_lost' },
          { status: 202 },
        ),
      )
      .mockResolvedValueOnce(
        response(
          { error: { code: 'RESULT_UNKNOWN', message: 'Reconstructed relay' } },
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(response({ entries: ['proof.txt'] }));
    vi.stubGlobal('fetch', fetcher);
    const body = { operation: 'list', projectId: 'demo' };
    const reading = queryApi('/hosts/host/files', body);
    await vi.advanceTimersByTimeAsync(500);
    await expect(reading).resolves.toEqual({ entries: ['proof.txt'] });
    expect(
      fetcher.mock.calls
        .filter(([, init]) => init.method === 'POST')
        .map(([, init]) => JSON.parse(init.body)),
    ).toEqual([body, body]);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('bounds repeated read failures and never retries authorization failures', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockImplementation(async () =>
        response(
          { error: { code: 'RESULT_UNKNOWN', message: 'Read unavailable' } },
          { status: 409 },
        ),
      );
    vi.stubGlobal('fetch', fetcher);
    const failed = queryApi('/hosts/host/files', { operation: 'read' }).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(1500);
    expect(await failed).toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(fetcher).toHaveBeenCalledTimes(3);
    fetcher
      .mockClear()
      .mockImplementation(async () =>
        response(
          { error: { code: 'FORBIDDEN', message: 'Denied' } },
          { status: 403 },
        ),
      );
    await expect(
      queryApi('/hosts/host/files', { operation: 'read' }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(fetcher).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledOnce();
  });
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
    expect(retryable(new ApiError('STALE_AGENT', 'Agent replaced', 409))).toBe(
      true,
    );
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

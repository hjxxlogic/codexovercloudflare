import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../apps/web/src/notifications.ts', () => ({ observe: vi.fn() }));
import { observe } from '../apps/web/src/notifications.ts';
import { api } from '../apps/web/src/api.ts';

const stop = vi.fn();
const fetcher = vi.fn<typeof fetch>();
function response(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'X-CoC-Demand': '1' } });
}
beforeEach(() => {
  vi.useFakeTimers();
  stop.mockReset();
  vi.mocked(observe).mockReset().mockReturnValue(stop);
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('location', { origin: 'https://example.test', pathname: '/' });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('bounded operation receipt recovery', () => {
  it('finds a completed result without a subscription notification and sends work only once', async () => {
    fetcher
      .mockResolvedValueOnce(
        response({ accepted: true, hostId: 'host', operationId: 'one' }, 202),
      )
      .mockResolvedValueOnce(response({ state: 'pending' }))
      .mockResolvedValueOnce(
        response({ state: 'completed', result: { id: 'session' } }),
      )
      .mockResolvedValue(response({ ok: true }));
    const result = api('/sessions', { hostId: 'host', mode: 'web' });
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toEqual({ id: 'session' });
    expect(
      fetcher.mock.calls.filter(([url]) => url === '/api/v1/sessions'),
    ).toHaveLength(1);
    expect(stop).toHaveBeenCalledOnce();
    const calls = fetcher.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it('retries transient receipt read failures while preserving the original operation identity', async () => {
    fetcher
      .mockResolvedValueOnce(
        response({ accepted: true, hostId: 'host', operationId: 'one' }, 202),
      )
      .mockResolvedValueOnce(
        response({ error: { code: 'BACKPRESSURE', message: 'Busy' } }, 429),
      )
      .mockResolvedValueOnce(response({ state: 'completed', result: 42 }))
      .mockResolvedValue(response({ ok: true }));
    const result = api('/hosts/host/probe', {});
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBe(42);
    expect(
      fetcher.mock.calls
        .slice(1)
        .every(([url]) => url === '/api/v1/hosts/host/operations/one'),
    ).toBe(true);
  });
  it('stops at the deadline, retains the operation ID and does not resend the command', async () => {
    fetcher
      .mockResolvedValueOnce(
        response(
          { accepted: true, hostId: 'host', operationId: 'original' },
          202,
        ),
      )
      .mockImplementation(async () => response({ state: 'pending' }));
    const outcome = api('/sessions', { hostId: 'host' }).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(31000);
    expect(await outcome).toMatchObject({
      code: 'RESULT_UNKNOWN',
      message: expect.stringContaining('original'),
    });
    expect(
      fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
    ).toHaveLength(1);
    const count = fetcher.mock.calls.length;
    expect(count).toBeLessThan(22);
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(count);
  });
  it('does not acknowledge a late result after the caller cancels', async () => {
    let resolve!: (value: Response) => void;
    const receipt = new Promise<Response>((done) => {
      resolve = done;
    });
    fetcher
      .mockResolvedValueOnce(
        response({ accepted: true, hostId: 'host', operationId: 'one' }, 202),
      )
      .mockReturnValueOnce(receipt);
    const controller = new AbortController();
    const result = api(
      '/sessions',
      { hostId: 'host' },
      controller.signal,
    ).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await result).toMatchObject({ name: 'AbortError' });
    resolve(response({ state: 'completed', result: 7 }));
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(stop).toHaveBeenCalledOnce();
  });
});

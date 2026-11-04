import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../apps/web/src/channel.ts', async (original) => ({
  ...(await original<typeof import('../apps/web/src/channel.ts')>()),
  endpointRequest: vi.fn(),
}));
import { endpointRequest, ChannelError } from '../apps/web/src/channel.ts';
import { api, queryApi, ApiError, retryable } from '../apps/web/src/api.ts';
const proof = {
  requestId: 'original',
  instance: 'agent-store',
  owner: 'a'.repeat(64),
};
beforeEach(() => {
  vi.mocked(endpointRequest).mockReset();
  vi.stubGlobal('location', new URL('https://relay.test/'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('encrypted endpoint API', () => {
  it('returns decrypted results without plaintext HTTP fallback', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    vi.mocked(endpointRequest).mockResolvedValue({ data: { ok: true } });
    await expect(api('/hosts/host/projects')).resolves.toEqual({ ok: true });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('saves the proved original result before returning to the caller', async () => {
    let release!: () => void;
    const persisted = new Promise<void>((r) => {
      release = r;
    });
    const commit = vi.fn(() => persisted);
    vi.mocked(endpointRequest).mockResolvedValue({
      data: { id: 'host~session' },
      intent: proof,
    });
    let ended = false;
    const result = api(
      '/sessions',
      { hostId: 'host', mode: 'web' },
      undefined,
      'original',
      undefined,
      { ...proof, commit },
    ).then((v) => {
      ended = true;
      return v;
    });
    await vi.waitFor(() => expect(commit).toHaveBeenCalledOnce());
    expect(ended).toBe(false);
    release();
    await expect(result).resolves.toEqual({ id: 'host~session' });
    expect(commit).toHaveBeenCalledWith(
      { data: { id: 'host~session' } },
      proof,
    );
  });
  it.each([
    undefined,
    { ...proof, instance: 'other' },
    { ...proof, owner: 'b'.repeat(64) },
    { ...proof, requestId: 'other' },
    { ...proof, ack: true },
  ])('rejects unproved or mismatched original receipts %j', async (receipt) => {
    const commit = vi.fn();
    vi.mocked(endpointRequest).mockResolvedValue({
      data: { id: 'session' },
      ...(receipt ? { intent: receipt } : {}),
    });
    await expect(
      api('/sessions', { hostId: 'host' }, undefined, 'original', undefined, {
        ...proof,
        commit,
      }),
    ).rejects.toMatchObject({
      code: receipt ? 'DELIVERY_STATE_MISMATCH' : 'RESULT_UNKNOWN',
    });
    expect(commit).not.toHaveBeenCalled();
  });
  it('commits durable business errors and preserves a failed local commit', async () => {
    const error = { code: 'PROJECT_NOT_FOUND', message: 'missing' };
    const commit = vi.fn().mockResolvedValue(undefined);
    vi.mocked(endpointRequest).mockResolvedValue({ error, intent: proof });
    await expect(
      api('/sessions', { hostId: 'host' }, undefined, 'original', undefined, {
        ...proof,
        commit,
      }),
    ).rejects.toMatchObject({ code: error.code });
    expect(commit).toHaveBeenCalledWith({ error }, proof);
    commit.mockRejectedValue(new Error('disk full'));
    await expect(
      api('/sessions', { hostId: 'host' }, undefined, 'original', undefined, {
        ...proof,
        commit,
      }),
    ).rejects.toThrow('disk full');
    expect(endpointRequest).toHaveBeenCalledTimes(2);
  });
  it('retries only read queries after a lost encrypted link', async () => {
    vi.useFakeTimers();
    vi.mocked(endpointRequest)
      .mockRejectedValueOnce(new ChannelError('RESULT_UNKNOWN', 'lost', 503))
      .mockResolvedValue({ data: { ok: true } });
    const result = queryApi('/hosts/host/files', { operation: 'read' });
    await vi.advanceTimersByTimeAsync(600);
    await expect(result).resolves.toEqual({ ok: true });
    expect(endpointRequest).toHaveBeenCalledTimes(2);
  });
  it('does not resubmit mutations with an unknown result', async () => {
    vi.mocked(endpointRequest).mockRejectedValue(
      new ChannelError('RESULT_UNKNOWN', 'lost', 503),
    );
    await expect(
      api('/sessions', { hostId: 'host' }, undefined, 'same-original'),
    ).rejects.toMatchObject({ code: 'RESULT_UNKNOWN' });
    expect(endpointRequest).toHaveBeenCalledOnce();
    expect(vi.mocked(endpointRequest).mock.calls[0][2]).toBe('same-original');
  });
  it.each(['UNAUTHORIZED', 'FORBIDDEN'])(
    'preserves %s and never retries it',
    async (code) => {
      vi.mocked(endpointRequest).mockResolvedValue({
        error: { code, message: 'denied' },
      });
      await expect(queryApi('/hosts/host/projects')).rejects.toMatchObject({
        code,
        status: code === 'UNAUTHORIZED' ? 401 : 403,
      });
      expect(endpointRequest).toHaveBeenCalledOnce();
    },
  );
  it('forwards only the original receipt identity and controller headers inside encryption', async () => {
    vi.mocked(endpointRequest).mockResolvedValue({
      data: { ok: true },
      intent: proof,
    });
    const signal = new AbortController().signal,
      headers = { 'X-CoC-Controller': 'private-controller' },
      commit = vi.fn();
    await api('/sessions', { hostId: 'host' }, signal, 'original', headers, {
      ...proof,
      commit,
    });
    expect(endpointRequest).toHaveBeenCalledWith(
      '/sessions',
      { hostId: 'host' },
      'original',
      signal,
      { instance: 'agent-store', ack: undefined },
      headers,
    );
  });
  it('rejects missing business targets instead of sending a plaintext request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(api('/sessions', { mode: 'web' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('continues to apply HTTP gateway and Access errors to control-plane calls', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
      ),
    );
    await expect(api('/auth/me')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      status: 502,
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>', { headers: { 'Content-Type': 'text/html' } }),
        ),
    );
    await expect(api('/auth/me')).rejects.toMatchObject({
      code: 'ACCESS_REQUIRED',
      status: 401,
    });
  });
  it('keeps retry policy bounded to transient transport failures', () => {
    expect(retryable(new ApiError('RESULT_UNKNOWN', 'unknown', 503))).toBe(
      false,
    );
    expect(retryable(new ApiError('RATE_LIMIT', 'retry', 429))).toBe(true);
    expect(retryable(new ApiError('FORBIDDEN', 'deny', 403))).toBe(false);
  });
});

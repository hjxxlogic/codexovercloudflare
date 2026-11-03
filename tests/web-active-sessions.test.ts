import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../apps/web/src/api.ts', () => ({ api: vi.fn() }));
import { api } from '../apps/web/src/api.ts';
import { loadActiveSessions } from '../apps/web/src/active-sessions.tsx';

beforeEach(() => vi.mocked(api).mockReset());
it('loads every mailbox page and preserves the host and account filter', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ data: [{ id: 'host~a' }], nextCursor: 'host~a' })
    .mockResolvedValueOnce({ data: [{ id: 'host~b' }], nextCursor: null });
  const signal = new AbortController().signal;
  expect(
    (await loadActiveSessions('host', signal)).map((row) => row.id),
  ).toEqual(['host~a', 'host~b']);
  expect(api).toHaveBeenCalledTimes(2);
  for (const [path, , passedSignal] of vi.mocked(api).mock.calls) {
    const url = new URL(path, 'https://test.invalid');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      hostId: 'host',
      mine: 'true',
      state: 'ready',
      paged: 'true',
    });
    expect(passedSignal).toBe(signal);
  }
  expect(vi.mocked(api).mock.calls[1][0]).toContain('cursor=host~a');
});
it('reports a failed later page instead of presenting an incomplete list as complete', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ data: [{ id: 'host~a' }], nextCursor: 'host~a' })
    .mockRejectedValueOnce(new Error('offline'));
  await expect(
    loadActiveSessions('host', new AbortController().signal),
  ).rejects.toThrow('offline');
});

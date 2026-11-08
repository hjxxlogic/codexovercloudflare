import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../apps/web/src/api.ts', () => ({ api: vi.fn() }));
import { api } from '../apps/web/src/api.ts';
import {
  loadActiveSessions,
  loadSessionCatalog,
  mergeSessionCatalog,
} from '../apps/web/src/active-sessions.tsx';
import type { Session } from '../packages/protocol/src/index.ts';

const session = (
  id: string,
  state: Session['state'] = 'ready',
  updatedAt = 1,
) =>
  ({
    id,
    state,
    updatedAt,
    createdAt: 1,
    mode: 'web',
    projectId: 'project',
    running: false,
  }) as Session;
beforeEach(() => {
  vi.mocked(api).mockReset();
  vi.mocked(api).mockResolvedValue({ data: [], nextCursor: null });
});
it('loads every mailbox page and preserves the host and account filter', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ data: [session('host~a')], nextCursor: 'host~a' })
    .mockResolvedValueOnce({ data: [session('host~b')], nextCursor: null });
  const signal = new AbortController().signal;
  expect(
    (await loadActiveSessions('host', signal)).map((row) => row.id),
  ).toEqual(['host~a', 'host~b']);
  expect(api).toHaveBeenCalledTimes(4);
  for (const [path, , passedSignal] of vi.mocked(api).mock.calls) {
    const url = new URL(path, 'https://test.invalid');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      hostId: 'host',
      mine: 'true',
      paged: 'true',
    });
    expect(['ready', 'starting', 'closing']).toContain(
      url.searchParams.get('state'),
    );
    expect(passedSignal).toBe(signal);
  }
  expect(vi.mocked(api).mock.calls[1][0]).toContain('cursor=host~a');
});
it('reports a failed later page instead of presenting an incomplete list as complete', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ data: [session('host~a')], nextCursor: 'host~a' })
    .mockRejectedValueOnce(new Error('offline'));
  await expect(
    loadActiveSessions('host', new AbortController().signal),
  ).rejects.toThrow('offline');
});

it('includes starting and closing sessions and rejects repeated pagination cursors', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce({ data: [session('ready')], nextCursor: null })
    .mockResolvedValueOnce({
      data: [session('starting', 'starting')],
      nextCursor: null,
    })
    .mockResolvedValueOnce({
      data: [session('closing', 'closing')],
      nextCursor: null,
    });
  expect(
    (await loadActiveSessions('host', new AbortController().signal)).map(
      (s) => s.id,
    ),
  ).toEqual(['ready', 'starting', 'closing']);
  vi.mocked(api).mockResolvedValue({ data: [], nextCursor: 'repeated' });
  await expect(
    loadActiveSessions('host', new AbortController().signal),
  ).rejects.toThrow('重复分页');
});

it('loads active sessions beyond the first history page without changing its pagination cursor or scope', async () => {
  const history = Array.from({ length: 100 }, (_, i) =>
    session('history-' + i, 'closed', 100),
  );
  vi.mocked(api).mockImplementation(async (path) => {
    const url = new URL(path, 'https://test.invalid');
    if (!url.searchParams.has('state'))
      return { data: history, nextCursor: 'history-99' };
    if (url.searchParams.get('state') === 'ready')
      return { data: [session('active-beyond-first-page')], nextCursor: null };
    return { data: [], nextCursor: null };
  });
  const page = await loadSessionCatalog('host', new AbortController().signal);
  expect(page.nextCursor).toBe('history-99');
  expect(page.data).toHaveLength(101);
  expect(page.data.some((s) => s.id === 'active-beyond-first-page')).toBe(true);
  for (const [path] of vi.mocked(api).mock.calls)
    expect(new URL(path, 'https://test.invalid').searchParams.has('mine')).toBe(
      false,
    );
});

it('preserves a newer closed state and deletion barriers when merging delayed active pages', () => {
  const closed = session('same', 'closed', 10);
  expect(mergeSessionCatalog([closed], [session('same', 'ready', 1)])).toEqual([
    closed,
  ]);
  expect(mergeSessionCatalog([closed], [session('same', 'ready', 10)])).toEqual(
    [closed],
  );
  expect(mergeSessionCatalog([session('same', 'ready', 10)], [closed])).toEqual(
    [closed],
  );
  const deleted = { ...closed, deleted: true };
  expect(
    mergeSessionCatalog([deleted], [session('same', 'ready', 20)]),
  ).toEqual([deleted]);
});

import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SessionHistory } from '../apps/web/src/session-history.tsx';
import type { Session } from '../packages/protocol/src/index.ts';

it('uses the Codex name, then Codex preview, ahead of a stale CoC title for the same thread', () => {
  const session = {
    id: 'host~session',
    threadId: 'thread',
    projectId: 'project',
    mode: 'web',
    state: 'closed',
    running: false,
    title: 'stale CoC title',
    createdAt: 1,
    updatedAt: 2,
  } as Session;
  const render = (name?: string, preview = 'Codex preview') =>
    renderToStaticMarkup(
      <SessionHistory
        sessions={[session]}
        threads={[{ id: 'thread', name, preview, updatedAt: 3 }]}
        project="project"
        projectName="Project"
        search=""
        online
        loading={false}
        error=""
        creating={false}
        onSelect={() => {}}
        onResume={() => {}}
      />,
    );
  const named = render('Codex /resume 名称');
  expect(named).toContain('<span>Codex /resume 名称</span>');
  expect(named).not.toContain('stale CoC title');
  expect(render()).toContain('<span>Codex preview</span>');
  expect(render(undefined, '')).toContain('<span>stale CoC title</span>');
});

it('separates archived rows, fences tombstones and disables active/offline management', () => {
  const session = {
    id: 's',
    threadId: 'thread',
    projectId: 'project',
    mode: 'web',
    state: 'closed',
    running: false,
    title: 'Stored history',
    createdAt: 1,
    archived: true,
  } as Session;
  const render = (overrides: Record<string, unknown> = {}) =>
    renderToStaticMarkup(
      <SessionHistory
        sessions={[session]}
        threads={[]}
        project="project"
        projectName="Project"
        search=""
        online
        loading={false}
        error=""
        creating={false}
        onSelect={() => {}}
        onResume={() => {}}
        onManage={() => {}}
        {...overrides}
      />,
    );
  expect(render()).not.toContain('Stored history');
  const archived = render({ archived: true });
  expect(archived).toContain('Stored history');
  expect(archived).toContain('aria-label="取消归档"');
  expect(archived).toContain('aria-label="永久删除会话"');
  expect(
    render({
      sessions: [{ ...session, deleted: true }],
      threads: [{ id: 'thread', preview: 'Stale Codex row', updatedAt: 1 }],
    }),
  ).not.toContain('Stale Codex row');
  for (const overrides of [
    { online: false },
    { managing: true },
    { sessions: [{ ...session, archived: false, state: 'ready' }] },
  ]) {
    const html = render({ archived: true, ...overrides });
    if (html.includes('history-actions'))
      expect(html.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  }
});

it('puts running and open sessions before newer history and exposes compact status labels', () => {
  const base = {
    projectId: 'project',
    mode: 'web',
    createdAt: 1,
    running: false,
  } as Session;
  const html = renderToStaticMarkup(
    <SessionHistory
      compact
      sessions={[
        {
          ...base,
          id: 'closed',
          threadId: 'closed-thread',
          title: 'Recent closed',
          state: 'closed',
          updatedAt: 100,
        },
        {
          ...base,
          id: 'open',
          threadId: 'open-thread',
          title: 'Older open',
          state: 'ready',
          updatedAt: 2,
        },
        {
          ...base,
          id: 'running',
          threadId: 'running-thread',
          title: 'Oldest running',
          state: 'ready',
          running: true,
          updatedAt: 1,
        },
        {
          ...base,
          id: 'newer-idle-runtime-same-thread',
          threadId: 'running-thread',
          title: 'Idle duplicate must not hide a running task',
          state: 'ready',
          updatedAt: 100,
        },
      ]}
      threads={[
        { id: 'history-thread', preview: 'Newest history', updatedAt: 1000 },
      ]}
      project="project"
      projectName="Project"
      search=""
      online
      loading={false}
      error=""
      creating={false}
      onSelect={() => {}}
      onResume={() => {}}
    />,
  );
  expect(html.indexOf('Oldest running')).toBeLessThan(
    html.indexOf('Older open'),
  );
  expect(html.indexOf('Older open')).toBeLessThan(
    html.indexOf('Newest history'),
  );
  for (const label of ['运行中', '已打开', '已结束', '历史'])
    expect(html).toContain(`会话状态：${label}`);
  expect(html).not.toContain('Idle duplicate');
});

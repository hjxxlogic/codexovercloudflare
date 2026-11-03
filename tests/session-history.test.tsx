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

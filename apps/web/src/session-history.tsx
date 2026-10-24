import type { Session } from '../../../packages/protocol/src/index.ts';

export type Thread = {
  id: string;
  preview: string;
  name?: string;
  updatedAt: number;
};
export function SessionHistory({
  sessions,
  threads,
  project,
  projectName,
  selected,
  search,
  online,
  loading,
  error,
  creating,
  onSelect,
  onResume,
}: {
  sessions: Session[];
  threads: Thread[];
  project: string;
  projectName: string;
  selected?: Session;
  search: string;
  online: boolean;
  loading: boolean;
  error: string;
  creating: boolean;
  onSelect: (session: Session) => void;
  onResume: (threadId: string) => void;
}) {
  const rows = new Map<string, { session?: Session; thread?: Thread }>();
  for (const thread of threads) rows.set(thread.id, { thread });
  for (const session of sessions) {
    if (session.projectId !== project || session.mode !== 'web') continue;
    const key = session.threadId || session.id;
    const row = rows.get(key) || {};
    const previous = row.session;
    if (
      !previous ||
      (session.state === 'ready' && previous.state !== 'ready') ||
      ((session.state === 'ready') === (previous.state === 'ready') &&
        (session.updatedAt || session.createdAt) >
          (previous.updatedAt || previous.createdAt))
    )
      row.session = session;
    rows.set(key, row);
  }
  const activity = (row: { session?: Session; thread?: Thread }) =>
    Math.max(
      row.session?.updatedAt || row.session?.createdAt || 0,
      (row.thread?.updatedAt || 0) * 1000,
    );
  const visible = [...rows]
    .filter(([, { session, thread }]) =>
      `${session?.title || ''} ${thread?.name || ''} ${thread?.preview || ''} ${session?.id || ''} ${thread?.id || ''} ${projectName}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) => activity(b[1]) - activity(a[1]));
  return (
    <>
      {error && (
        <p role="alert">历史目录读取失败：{error}。可使用上方刷新重试。</p>
      )}
      {loading && <p role="status">正在读取历史目录…</p>}
      {visible.map(([key, row]) => {
        const { session, thread } = row;
        const active = session?.state === 'ready';
        const title =
          session?.title ||
          thread?.name ||
          thread?.preview ||
          (active ? '进行中的对话' : '历史会话（只读）');
        const current =
          !!selected &&
          (selected.id === session?.id || selected.threadId === key);
        return (
          <div className="history-row" key={key}>
            <button
              className={`session ${current ? 'active' : ''}`}
              disabled={!session && (creating || !online)}
              onClick={() => (session ? onSelect(session) : onResume(key))}
              title={thread?.preview || title}
            >
              <span>{title}</span>
              <small>
                {projectName} ·{' '}
                {active
                  ? '进行中 · 查看对话'
                  : session
                    ? '已结束 · 查看历史'
                    : '恢复并继续'}
                {!online ? ' · 本机目录' : ''}
              </small>
              <small>
                {new Date(activity(row)).toLocaleString()}
                {current ? ' · 当前对话' : ''}
              </small>
            </button>
            {session && !active && thread && (
              <button
                disabled={creating || !online}
                onClick={() => onResume(key)}
                aria-label={`恢复并继续：${title}`}
              >
                恢复并继续
              </button>
            )}
          </div>
        );
      })}
      {!visible.length && !loading && !error && (
        <p className="empty-hint">
          {search
            ? '没有匹配的已加载会话。'
            : project
              ? '暂无本地历史，创建新对话开始。'
              : '请先选择主机与项目。'}
        </p>
      )}
    </>
  );
}

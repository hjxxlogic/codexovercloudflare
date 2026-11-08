import { IconButton } from './happier/icon-button.tsx';
import { Icon } from './happier/icon.tsx';
import { t, localeTag } from './i18n.ts';
import type { Session } from '../../../packages/protocol/src/index.ts';

export type Thread = {
  id: string;
  preview: string;
  name?: string;
  updatedAt: number;
  archived?: boolean;
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
  compact = false,
  archived = false,
  managing = false,
  onManage,
}: {
  compact?: boolean;
  archived?: boolean;
  managing?: boolean;
  onManage?: (
    threadId: string,
    operation: 'archive' | 'unarchive' | 'delete',
  ) => void;
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
    if (
      session.projectId !== project ||
      session.mode !== 'web' ||
      session.deleted
    )
      continue;
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
  const deleted = new Set(
    sessions.filter((s) => s.deleted).map((s) => s.threadId),
  );
  const visible = [...rows]
    .filter(
      ([id, { session, thread }]) =>
        !deleted.has(id) &&
        (thread?.archived ?? session?.archived ?? false) === archived,
    )
    .filter(([, { session, thread }]) =>
      `${session?.title || ''} ${thread?.name || ''} ${thread?.preview || ''} ${session?.id || ''} ${thread?.id || ''} ${projectName}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    )
    .sort((a, b) => activity(b[1]) - activity(a[1]));
  return (
    <>
      {error && (
        <p role="alert">
          {t('历史目录读取失败：')}
          {t(error)}
          {t('。可使用上方刷新重试。')}
        </p>
      )}
      {loading && <p role="status">{t('正在读取历史目录…')}</p>}
      {visible.map(([key, row]) => {
        const { session, thread } = row;
        const active = session?.state === 'ready';
        const title =
          thread?.name ||
          thread?.preview ||
          session?.title ||
          (active ? t('进行中的对话') : t('历史会话（只读）'));
        const current =
          !!selected &&
          (selected.id === session?.id || selected.threadId === key);
        return (
          <div className="history-row" key={key}>
            <button
              className={`session ${compact ? 'session-compact' : ''} ${current ? 'active' : ''}`}
              disabled={archived ? !session : !session && (creating || !online)}
              onClick={() => (session ? onSelect(session) : onResume(key))}
              title={thread?.preview || title}
            >
              {compact && <Icon name="chat" size={15} />}
              <span>{title}</span>
              {compact ? (
                <time
                  dateTime={new Date(activity(row)).toISOString()}
                  title={new Date(activity(row)).toLocaleString(localeTag())}
                >
                  {new Date(activity(row)).toLocaleDateString(localeTag(), {
                    month: 'short',
                    day: 'numeric',
                  })}
                </time>
              ) : (
                <>
                  <small>
                    {projectName} ·{' '}
                    {active
                      ? t('进行中 · 查看对话')
                      : session
                        ? t('已结束 · 查看历史')
                        : t('继续对话')}
                    {!online ? t(' · 本机目录') : ''}
                  </small>
                  <small>
                    {new Date(activity(row)).toLocaleString(localeTag())}
                    {current ? t(' · 当前对话') : ''}
                  </small>
                </>
              )}
            </button>
            {onManage && (thread?.id || session?.threadId) && (
              <div className="history-actions">
                <IconButton
                  icon={archived ? 'back' : 'folder'}
                  label={t(archived ? '取消归档' : '归档会话')}
                  disabled={
                    !online ||
                    managing ||
                    (!!session &&
                      ['ready', 'starting', 'closing'].includes(session.state))
                  }
                  title={t('请先结束会话并处理待确认任务')}
                  onClick={() =>
                    onManage(key, archived ? 'unarchive' : 'archive')
                  }
                />
                <IconButton
                  icon="trash"
                  label={t('永久删除会话')}
                  disabled={
                    !online ||
                    managing ||
                    (!!session &&
                      ['ready', 'starting', 'closing'].includes(session.state))
                  }
                  title={t('请先结束会话并处理待确认任务')}
                  onClick={() => onManage(key, 'delete')}
                />
              </div>
            )}
          </div>
        );
      })}
      {!visible.length && !loading && !error && (
        <p className="empty-hint">
          {search
            ? t('没有匹配的已加载会话。')
            : project
              ? t('暂无本地历史，创建新对话开始。')
              : t('请先选择主机与项目。')}
        </p>
      )}
    </>
  );
}

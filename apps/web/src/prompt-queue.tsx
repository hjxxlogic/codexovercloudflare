import type { Session } from '../../../packages/protocol/src/index.ts';
import { t } from './i18n.ts';

export function PromptQueue({
  queue,
  enabled,
  onRun,
  onCancel,
}: {
  queue: NonNullable<Session['promptQueue']>;
  enabled: boolean;
  onRun: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  if (!queue.length) return null;
  return (
    <section className="prompt-queue" aria-label={t('排队消息')}>
      <strong>
        {t('排队消息')} · {queue.length}
      </strong>
      <ol>
        {queue.map((entry) => (
          <li key={entry.id}>
            <span role="status">
              {t(
                {
                  queued: '已排队',
                  stopping: '正在停止，随后执行',
                  starting: '正在开始',
                  failed: '执行失败 · 队列暂停',
                  unknown: '执行结果未知 · 队列暂停',
                }[entry.state],
              )}
            </span>
            <p className="queue-text">{entry.text}</p>
            {entry.model && <small>{entry.model}</small>}
            {entry.error && <small>{entry.error}</small>}
            <div className="row">
              <button
                type="button"
                disabled={
                  !enabled || !['queued', 'failed'].includes(entry.state)
                }
                onClick={() => onRun(entry.id)}
              >
                {t('立即执行')}
              </button>
              <button
                type="button"
                disabled={
                  !enabled || ['starting', 'unknown'].includes(entry.state)
                }
                onClick={() => onCancel(entry.id)}
              >
                {t('取消排队')}
              </button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

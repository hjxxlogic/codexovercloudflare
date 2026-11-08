import type { Session } from '../../../packages/protocol/src/index.ts';
import { t } from './i18n.ts';

export const openSessionStates = ['ready', 'starting', 'closing'] as const;

export function activeSession(session?: Session) {
  return (
    !!session &&
    !session.deleted &&
    openSessionStates.some((state) => state === session.state)
  );
}

export function sessionPriority(session?: Session) {
  return activeSession(session) ? (session?.running ? 0 : 1) : 2;
}

export function SessionStatus({ session }: { session?: Session }) {
  const [state, label] = !session
    ? ['history', '历史']
    : session.state === 'ready'
      ? session.running
        ? ['running', '运行中']
        : ['open', '已打开']
      : session.state === 'starting'
        ? ['starting', '启动中']
        : session.state === 'closing'
          ? ['closing', '结束中']
          : session.state === 'failed'
            ? ['failed', '已中断']
            : ['ended', '已结束'];
  return (
    <span
      className={`session-status session-status-${state}`}
      aria-label={t('会话状态：{0}', t(label))}
      title={
        state === 'open' ? t('会话仍打开，当前没有运行中的任务') : t(label)
      }
    >
      <i aria-hidden="true" />
      {t(label)}
    </span>
  );
}

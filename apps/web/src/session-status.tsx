import type { Session } from '../../../packages/protocol/src/index.ts';
import { t } from './i18n.ts';
import { Icon } from './happier/icon.tsx';

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

export function sessionStatusDetails(session?: Session) {
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
  return {
    state,
    label: t(label),
    description:
      state === 'open' ? t('会话仍打开，当前没有运行中的任务') : t(label),
  };
}

export function SessionStatus({
  session,
  iconOnly = false,
}: {
  session?: Session;
  iconOnly?: boolean;
}) {
  const { state, label, description } = sessionStatusDetails(session);
  return (
    <span
      className={`session-status session-status-${state}${iconOnly ? ' session-status-icon' : ''}`}
      role={iconOnly ? 'img' : undefined}
      aria-label={t('会话状态：{0}', label)}
      title={description}
    >
      {iconOnly ? (
        <Icon name="chat" size={15} />
      ) : (
        <>
          <i aria-hidden="true" />
          {label}
        </>
      )}
    </span>
  );
}

import { useEffect, useRef, useState } from 'react';
import { t } from './i18n.ts';

const supported = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);

export function AutoApproval({
  approvals,
  ready,
  pending,
  onApprove,
}: {
  approvals: {
    approvalId: string;
    method: string;
    submitted?: boolean;
    unsupported?: boolean;
  }[];
  ready: boolean;
  pending: boolean;
  onApprove: (id: string) => boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  const [submitted, setSubmitted] = useState(0);
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (!enabled || !ready || pending) return;
    const next = approvals.find(
      (approval) =>
        !approval.submitted &&
        !approval.unsupported &&
        supported.has(approval.method) &&
        !attempted.current.has(approval.approvalId),
    );
    if (!next) return;
    // Keep attempts through reconnects and toggles: a lost acknowledgement is not a new approval.
    attempted.current.add(next.approvalId);
    if (onApprove(next.approvalId)) setSubmitted((value) => value + 1);
    else attempted.current.delete(next.approvalId);
  }, [enabled, ready, pending, approvals, onApprove]);

  return (
    <section
      className={`auto-approval${enabled ? ' is-enabled' : ''}`}
      aria-label={t('会话自动批准')}
    >
      <label>
        <input
          type="checkbox"
          checked={enabled}
          disabled={!ready && !enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        {t('自动批准当前会话')}
      </label>
      <details>
        <summary>{t('含额外权限')}</summary>
        <div className="auto-approval-details">
          <small>
            {t('包含命令、文件修改和本轮额外权限；切换会话或刷新后关闭。')}
          </small>
          {enabled && (
            <span role="status">
              {ready
                ? t('已自动提交 {0} 项审批', submitted)
                : t('自动批准已暂停，等待连接恢复')}
            </span>
          )}
        </div>
      </details>
    </section>
  );
}

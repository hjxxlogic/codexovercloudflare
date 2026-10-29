import { useState } from 'react';
import { t } from './i18n.ts';

export function AutoApproval({
  enabled,
  ready,
  onChange,
}: {
  enabled?: boolean;
  ready: boolean;
  onChange: (enabled: boolean) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return (
    <section
      className={`auto-approval${enabled ? ' is-enabled' : ''}`}
      aria-label={t('会话自动批准')}
    >
      <label>
        <input
          type="checkbox"
          checked={enabled === true}
          disabled={!ready || pending || enabled === undefined}
          onChange={(event) => {
            setPending(true);
            setError('');
            void onChange(event.target.checked)
              .catch((e) =>
                setError(e instanceof Error ? e.message : String(e)),
              )
              .finally(() => setPending(false));
          }}
        />
        {t('自动批准当前会话')}
      </label>
      <details>
        <summary>{t('含额外权限')}</summary>
        <div className="auto-approval-details">
          <small>
            {t(
              '由 Agent 执行，关闭网页后继续生效；仅当前会话，停止会话后关闭。包含命令、文件修改和本轮额外权限。',
            )}
          </small>
          {enabled === undefined ? (
            <small>{t('请升级 Agent 以使用会话自动批准。')}</small>
          ) : (
            <span role="status">
              {pending
                ? t('正在保存…')
                : enabled
                  ? t('Agent 已启用自动批准')
                  : t('自动批准已关闭')}
            </span>
          )}
          {error && <small role="alert">{t(error)}</small>}
        </div>
      </details>
    </section>
  );
}

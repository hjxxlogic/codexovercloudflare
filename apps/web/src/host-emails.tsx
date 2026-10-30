import { useEffect, useState } from 'react';
import { accessEmailsSchema } from '../../../packages/protocol/src/index.ts';
import { api } from './api.ts';
import { t } from './i18n.ts';

export type EmailHost = {
  id: string;
  name: string;
  agentAccessEmails?: string[];
  accessEmailsOverride?: string[];
};

export function HostEmailSettings({
  host,
  saved,
  report,
}: {
  host: EmailHost;
  saved: () => Promise<void>;
  report: (error: unknown) => void;
}) {
  const [value, setValue] = useState(
    (host.accessEmailsOverride ?? host.agentAccessEmails ?? []).join('\n'),
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const configured = (
    host.accessEmailsOverride ??
    host.agentAccessEmails ??
    []
  ).join('\n');
  useEffect(() => setValue(configured), [configured]);
  async function save(emails: string[] | null) {
    setBusy(true);
    setDone(false);
    try {
      await api(`/admin/hosts/${host.id}/access-emails`, { emails });
      setValue((emails ?? host.agentAccessEmails ?? []).join('\n'));
      setDone(true);
      await saved();
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
  }
  return (
    <tr>
      <th scope="row">
        {host.name}
        <small className="id">{host.id}</small>
      </th>
      <td>
        {t(
          host.accessEmailsOverride === undefined
            ? '使用 Agent 配置'
            : '使用管理员配置',
        )}
      </td>
      <td>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const parsed = accessEmailsSchema.safeParse(
              value.split(/[\s,;]+/).filter(Boolean),
            );
            if (!parsed.success) {
              report(new Error(t('请输入最多 20 个有效邮箱，每行一个。')));
              return;
            }
            void save(parsed.data);
          }}
        >
          <label>
            {t('关联邮箱 {0}', host.name)}
            <textarea
              aria-label={t('关联邮箱 {0}', host.name)}
              value={value}
              rows={3}
              disabled={busy}
              onChange={(event) => {
                setValue(event.target.value);
                setDone(false);
              }}
            />
          </label>
          <div className="admin-table-actions">
            <button disabled={busy} type="submit">
              {t('保存关联邮箱')}
            </button>
            <button disabled={busy} type="button" onClick={() => void save([])}>
              {t('清空关联邮箱')}
            </button>
            <button
              disabled={busy || host.accessEmailsOverride === undefined}
              type="button"
              onClick={() => void save(null)}
            >
              {t('恢复 Agent 邮箱配置')}
            </button>
          </div>
          {done && <p role="status">{t('关联邮箱已保存')}</p>}
        </form>
      </td>
    </tr>
  );
}

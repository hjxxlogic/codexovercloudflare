import { t } from './i18n.ts';
import { useState } from 'react';
import { api } from './api.ts';

export function HostWakeSettings({
  host,
  saved,
  report,
}: {
  host: {
    id: string;
    name: string;
    agentWakeUrl?: string;
    wakeUrlOverride?: string;
  };
  saved: () => Promise<void>;
  report: (error: unknown) => void;
}) {
  const [url, setUrl] = useState(
    host.wakeUrlOverride ?? host.agentWakeUrl ?? '',
  );
  const [busy, setBusy] = useState(false);
  const formId = `wake-form-${host.id}`;
  async function save(value: string | null) {
    setBusy(true);
    try {
      await api(`/admin/hosts/${host.id}/wake-url`, { wakeUrl: value });
      if (value === null) setUrl(host.agentWakeUrl ?? '');
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
        {host.wakeUrlOverride === undefined
          ? t('使用 Agent 配置')
          : host.wakeUrlOverride
            ? t('使用管理员配置')
            : t('管理员已禁用唤醒')}
      </td>
      <td>
        <form
          id={formId}
          onSubmit={(event) => {
            event.preventDefault();
            void save(url);
          }}
        >
          <input
            aria-label={t('唤醒 URL {0}', host.name)}
            aria-describedby={`${formId}-hint`}
            type="url"
            autoComplete="off"
            placeholder="https://example.com/wake?key=…"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <small id={`${formId}-hint`}>
            {t('离线时由中继访问。管理员配置优先；保存空值禁用唤醒。')}
          </small>
        </form>
      </td>
      <td>
        <div className="admin-table-actions">
          <button disabled={busy} type="submit" form={formId}>
            {t('保存唤醒配置')}
          </button>
          <button disabled={busy} type="button" onClick={() => void save(null)}>
            {t('使用 Agent 配置')}
          </button>
        </div>
      </td>
    </tr>
  );
}

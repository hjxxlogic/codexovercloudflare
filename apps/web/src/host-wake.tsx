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
    <form
      className="card"
      onSubmit={(event) => {
        event.preventDefault();
        void save(url);
      }}
    >
      <h4>{host.name}</h4>
      <p>
        {host.wakeUrlOverride === undefined
          ? '使用 Agent 配置'
          : host.wakeUrlOverride
            ? '使用管理员配置'
            : '管理员已禁用唤醒'}
      </p>
      <label>
        唤醒 URL
        <input
          aria-label={`唤醒 URL ${host.name}`}
          type="url"
          autoComplete="off"
          placeholder="https://example.com/wake?key=…"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>
      <p>离线时由中继访问。管理员配置优先；保存空值禁用唤醒。</p>
      <div className="actions">
        <button disabled={busy} type="submit">
          保存唤醒配置
        </button>
        <button disabled={busy} type="button" onClick={() => void save(null)}>
          使用 Agent 配置
        </button>
      </div>
    </form>
  );
}

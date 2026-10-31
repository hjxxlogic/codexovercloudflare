import { AdminTable } from './admin-table.tsx';
import { t } from './i18n.ts';

type AgentHost = {
  id: string;
  name: string;
  online?: boolean | null;
  build?: { version: string };
};

export function AgentVersions({ hosts }: { hosts: AgentHost[] }) {
  const status = (host: AgentHost) =>
    t(
      host.online === true
        ? '在线'
        : host.online === false
          ? '离线'
          : '未知状态',
    );
  const version = (host: AgentHost) =>
    host.online === true ? host.build?.version || t('未上报') : '—';
  return (
    <section className="card" aria-label={t('Agent 运行版本')}>
      <h2>{t('Agent 运行版本')}</h2>
      <AdminTable
        label={t('Agent 运行版本')}
        columns={['服务器', '状态', 'Agent 版本'].map((label) => t(label))}
        rowValues={hosts.map((host) => [
          host.name,
          status(host),
          version(host),
        ])}
        empty={!hosts.length}
        emptyText={t('暂无服务器')}
      >
        {hosts.map((host) => (
          <tr key={host.id}>
            <th scope="row">{host.name}</th>
            <td>{status(host)}</td>
            <td>{version(host)}</td>
          </tr>
        ))}
      </AdminTable>
    </section>
  );
}

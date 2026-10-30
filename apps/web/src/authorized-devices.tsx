import { useState } from 'react';
import {
  AdminTable,
  compareRows,
  type TableSort,
  type SortValue,
} from './admin-table.tsx';
import { CopyText } from './conversation.tsx';
import { t, localeTag } from './i18n.ts';

export type DeviceCredential = {
  id: string;
  name: string;
  role: 'agent' | 'web' | 'cli';
  hostId: string;
  email?: string;
  created: number;
  lastSeen?: number;
  manager?: 'email' | 'owner';
  expires?: number;
};

export function AuthorizedDevices({
  credentials,
  hosts,
  busy,
  revoke,
}: {
  credentials: DeviceCredential[];
  hosts: { id: string; name: string }[];
  busy: boolean;
  revoke: (id: string) => void;
}) {
  const [mode, setMode] = useState<'agent' | 'client'>('agent');
  const [sort, setSort] = useState<TableSort>({
    column: -1,
    descending: false,
  });
  const columns = [
    '设备名称',
    '角色',
    '目标服务器',
    '授权时间',
    '上次看到',
    '操作',
  ].map((value) => t(value));
  const hostName = (id: string) =>
    hosts.find((host) => host.id === id)?.name || id;
  const roleName = (role: DeviceCredential['role']) =>
    role === 'agent' ? t('服务器 Agent') : role === 'web' ? 'CW' : 'CC';
  const values = (d: DeviceCredential): SortValue[] => [
    d.name,
    roleName(d.role),
    hostName(d.hostId),
    d.created,
    d.lastSeen,
    t('撤销') + d.name,
  ];
  const groups = new Map<
    string,
    { label: string; devices: DeviceCredential[] }
  >();
  for (const device of credentials) {
    if (mode === 'client' && device.role === 'agent') continue;
    const key =
      mode === 'agent'
        ? device.hostId
        : JSON.stringify([device.role, device.email || device.name]);
    const group = groups.get(key) || {
      label:
        mode === 'agent'
          ? `Agent · ${hostName(device.hostId)}`
          : `${roleName(device.role)} · ${device.email || device.name}`,
      devices: [],
    };
    group.devices.push(device);
    groups.set(key, group);
  }
  const rows = [...groups.entries()].map(([id, group]) => {
    const sorted = [...group.devices].sort((a, b) =>
      compareRows(values(a), values(b), sort),
    );
    const seen = group.devices.flatMap((d) =>
      d.lastSeen === undefined ? [] : [d.lastSeen],
    );
    return {
      id,
      ...group,
      sorted,
      values: [
        group.label,
        mode === 'agent' ? 'Agent' : roleName(sorted[0].role),
        hostName(sorted[0].hostId),
        Math.max(...group.devices.map((d) => d.created)),
        seen.length ? Math.max(...seen) : undefined,
        t('撤销') + group.label,
      ],
    };
  });
  const date = (value?: number) =>
    value === undefined ? (
      t('暂无记录')
    ) : (
      <time dateTime={new Date(value).toISOString()}>
        {new Date(value).toLocaleString(localeTag())}
      </time>
    );
  return (
    <>
      <label className="device-grouping">
        {t('折叠方式')}
        <select
          aria-label={t('折叠方式')}
          value={mode}
          onChange={(event) =>
            setMode(event.target.value as 'agent' | 'client')
          }
        >
          <option value="agent">{t('按 Agent 折叠')}</option>
          <option value="client">{t('按 CW/CC 折叠')}</option>
        </select>
      </label>
      <AdminTable
        label={t('已授权设备')}
        columns={columns}
        rowValues={rows.map((row) => row.values)}
        sort={sort}
        onSort={setSort}
        empty={!rows.length}
        emptyText={t('暂无已授权设备')}
      >
        {rows.map((group) => (
          <tr key={`${mode}:${group.id}`}>
            <td colSpan={columns.length}>
              <details className="device-group">
                <summary>
                  {group.label} · {group.devices.length} · {t('上次看到')}{' '}
                  {date(group.values[4] as number | undefined)}
                </summary>
                <AdminTable
                  label={group.label}
                  columns={columns}
                  rowValues={group.sorted.map(values)}
                  sort={sort}
                  onSort={setSort}
                  empty={false}
                  emptyText=""
                >
                  {group.sorted.map((d) => (
                    <tr key={d.id} data-credential-id={d.id}>
                      <th scope="row">
                        {d.name}
                        {d.email && (
                          <p>
                            {t('已验证邮箱：')}
                            {d.email}
                          </p>
                        )}
                        <details>
                          <summary>{t('授权标识与服务器')}</summary>
                          <p className="id">
                            {d.id} · {d.hostId}
                          </p>
                          <CopyText text={d.id} />
                        </details>
                      </th>
                      <td>
                        {roleName(d.role)}
                        {d.manager && <small>{t('管理身份')}</small>}
                      </td>
                      <td>
                        {hostName(d.hostId)}
                        <small className="id">{d.hostId}</small>
                      </td>
                      <td>
                        {date(d.created)}
                        <small>
                          {d.expires
                            ? `${t('有效期至')} ${date(d.expires)}`
                            : t('长期有效')}
                        </small>
                      </td>
                      <td>{date(d.lastSeen)}</td>
                      <td>
                        <button disabled={busy} onClick={() => revoke(d.id)}>
                          {t('撤销')} {d.name}
                        </button>
                      </td>
                    </tr>
                  ))}
                </AdminTable>
              </details>
            </td>
          </tr>
        ))}
      </AdminTable>
    </>
  );
}

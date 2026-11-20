import { IconButton } from './happier/icon-button.tsx';
import { useEffect, useId, useRef, useState } from 'react';
import { api, readApi, queryApi } from './api.ts';
import { observe } from './notifications.ts';
import { HistoryCache } from './history.ts';
import { OperationClient } from './operations.ts';
import { t } from './i18n.ts';

type Project = { id: string; name: string; path: string; available?: boolean };
type Catalog = {
  revision: number;
  projects: Project[];
  canManage: boolean;
  canCreate?: boolean;
};
function siblingDirectory(path = '') {
  const normalized = path.trim().replace(/[\\/]+$/, '');
  const separator = normalized.includes('\\') ? '\\' : '/';
  if (!normalized.startsWith(separator) && !/^[a-z]:/i.test(normalized))
    return '/';
  const index = normalized.lastIndexOf(separator);
  if (/^[a-z]:/i.test(normalized) && index < 3)
    return normalized.slice(0, 2) + separator;
  return index >= 0 ? normalized.slice(0, index + 1) : '/';
}
export function ProjectManager({
  hostId,
  hostName,
  admin = false,
  changed,
  operations,
  creationOnly = false,
  defaultProjectPath,
}: {
  hostId: string;
  hostName: string;
  admin?: boolean;
  changed?: () => Promise<void>;
  operations?: OperationClient | null;
  creationOnly?: boolean;
  defaultProjectPath?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activated, setActivated] = useState(false);
  const [ownOperations, setOwnOperations] = useState<OperationClient>();
  const client = operations || ownOperations;
  const [catalog, setCatalog] = useState<Catalog>();
  const [path, setPath] = useState(() => siblingDirectory(defaultProjectPath));
  const [name, setName] = useState('');
  const [selectedPath, setSelectedPath] = useState('');
  const [directoryName, setDirectoryName] = useState<string>();
  const [working, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const busy = working || recovering;
  const [error, setError] = useState('');
  const [created, setCreated] = useState(false);
  const formId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const projectNameInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<Record<string, unknown>>();
  const [directories, setDirectories] = useState<{
    path: string;
    parent: string;
    directories: { name: string; path: string }[];
    truncated: boolean;
  }>();
  useEffect(() => {
    if (busy) return;
    if (created) trigger.current?.focus();
    if (selectedPath) projectNameInput.current?.focus();
  }, [created, busy, selectedPath]);
  const endpoint = `${admin ? '/admin' : ''}/hosts/${hostId}/project-management`;
  useEffect(() => {
    if (!admin || !activated) return;
    let disposed = false;
    const controller = new AbortController();
    let cache: HistoryCache | undefined, own: OperationClient | undefined;
    void api(`/admin/hosts/${hostId}/identity`, undefined, controller.signal)
      .then(async ({ identity }) => {
        if (disposed) return;
        cache = new HistoryCache(
          JSON.stringify([location.origin, identity, hostId]),
        );
        own = new OperationClient(cache, {
          host: hostId,
          owner: identity,
          admin: true,
        });
        setOwnOperations(own);
        await own.start();
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    return () => {
      disposed = true;
      controller.abort();
      own?.stop();
      cache?.close();
      setOwnOperations(undefined);
    };
  }, [hostId, admin, activated]);
  useEffect(() => {
    if (!open || !client) return;
    let disposed = false;
    const controller = new AbortController();
    setRecovering(true);
    void client
      .records()
      .then(async (records) => {
        const original = records.find(
          (record) => record.path === endpoint && record.state !== 'confirmed',
        );
        if (!original?.body) return;
        if (disposed) return;
        setPending(original.body);
        const result = await client.resume(
          original.requestId,
          controller.signal,
        );
        if (disposed) return;
        setRecovering(false);
        await applyResult(original.body, result);
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      })
      .finally(() => {
        if (!disposed) setRecovering(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [open, client, endpoint]);
  async function refresh(refreshList = false, initialize = false) {
    setBusy(true);
    setError('');
    try {
      const next: Catalog = await readApi(endpoint);
      setCatalog(next);
      const canCreate = next.canCreate ?? next.canManage;
      if ((open || initialize) && canCreate && !directories && !selectedPath) {
        const initial = siblingDirectory(
          defaultProjectPath || next.projects[0]?.path,
        );
        setPath(initial);
        await loadDirectory(initial);
      }
      if (refreshList) await changed?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!open || admin) return;
    const abort = new AbortController();
    const stop = observe(`/ws/v1/hosts/${hostId}`, (event) => {
      if (event.type === 'change' && event.scope === 'projects')
        void readApi(endpoint, abort.signal)
          .then(setCatalog)
          .catch(() => {});
    });
    return () => {
      abort.abort();
      stop();
    };
  }, [open, admin, hostId, endpoint]);
  async function mutate(data: Record<string, unknown>) {
    setCreated(false);
    const request = data.requestId
      ? data
      : {
          ...data,
          revision: catalog!.revision,
          requestId: crypto.randomUUID(),
        };
    setBusy(true);
    setError('');
    setPending(request);
    try {
      if (!client) throw new Error('本机存储尚未就绪，请稍后重试');
      const result = await client.submit(
        endpoint,
        request,
        String(request.requestId),
        {
          kind: 'project',
        },
      );
      await applyResult(request, result);
    } catch (e) {
      setError(String(e));
      const original = (await client?.records().catch(() => []))?.find(
        (record) => record.requestId === request.requestId,
      );
      if (!original || original.result?.error) setPending(undefined);
    } finally {
      setBusy(false);
    }
  }
  async function applyResult(
    request: Record<string, unknown>,
    result: Catalog & { path?: string },
  ) {
    setCatalog(result);
    setPending(undefined);
    if (request.operation === 'mkdir' && result.path) {
      setPath(result.path);
      setDirectories({
        path: result.path,
        parent: String(request.path),
        directories: [],
        truncated: false,
      });
      setDirectoryName(undefined);
      setSelectedPath(result.path);
      return;
    }
    if (request.operation === 'add') {
      setName('');
      setSelectedPath('');
      setDirectoryName(undefined);
      if (creationOnly) {
        setDirectories(undefined);
        setCreated(true);
        setOpen(false);
      }
    }
    await changed?.();
  }
  async function loadDirectory(directory: string) {
    const result = await queryApi(endpoint, {
      operation: 'browse',
      path: directory,
    });
    setPath(result.path);
    setDirectories(result);
    setDirectoryName(undefined);
  }
  async function browse(directory: string) {
    if (!directory.trim()) return;
    setBusy(true);
    setError('');
    try {
      await loadDirectory(directory);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="project-management">
      <div className="project-management-actions">
        {creationOnly && (
          <IconButton
            icon="refresh"
            label={t('刷新项目')}
            disabled={busy}
            onClick={() => void refresh(true)}
          />
        )}
        {creationOnly ? (
          <IconButton
            icon={open ? 'close' : 'plus'}
            label={t(open ? '收起新建项目' : '新建项目')}
            showLabel
            ref={trigger}
            aria-expanded={open}
            aria-controls={open ? formId : undefined}
            disabled={busy}
            onClick={() => {
              setCreated(false);
              setOpen(!open);
              if (!open) void refresh(false, true);
            }}
          />
        ) : (
          <button
            onClick={() => {
              setActivated(true);
              setOpen(!open);
              if (!open) void refresh(false, true);
            }}
          >
            {t('项目管理')} · {hostName}
          </button>
        )}
      </div>
      {created && <p role="status">{t('项目已添加')}</p>}
      {!open && creationOnly && error && <p role="alert">{error}</p>}
      {open && (
        <div
          id={formId}
          className={creationOnly ? 'project-creation' : undefined}
        >
          <p>
            {t('目标 Agent：')}
            {hostName} <code>{hostId}</code>
          </p>
          {!creationOnly && (
            <IconButton
              icon="refresh"
              label={t('刷新项目')}
              disabled={busy}
              onClick={() => void refresh()}
            />
          )}
          {error && <p role="alert">{error}</p>}
          {busy && creationOnly && (
            <p role="status">
              {t(
                pending?.operation === 'mkdir'
                  ? '正在新建目录…'
                  : pending
                    ? '正在确认项目登记…'
                    : '正在读取…',
              )}
            </p>
          )}
          {pending && !busy && (
            <div role="status">
              <p>{t('操作结果未确认，请重试原请求或刷新核对后继续。')}</p>
              <IconButton
                icon="refresh"
                label={t('重试原请求')}
                onClick={() => void mutate(pending)}
              />
              <IconButton
                icon="refresh"
                label={t('刷新并核对')}
                onClick={() => {
                  void refresh();
                }}
              />
            </div>
          )}
          {catalog && (
            <>
              {!creationOnly && !catalog.projects.length && (
                <p>{t('尚未登记项目')}</p>
              )}
              {!creationOnly && (
                <ul>
                  {catalog.projects.map((p) => (
                    <li key={p.id}>
                      <strong>{p.name}</strong> <code>{p.path}</code>{' '}
                      {p.available === false && t('目录不可用')}
                      <small className="id">{p.id}</small>
                      {catalog.canManage && (
                        <>
                          <IconButton
                            icon="code"
                            label={t('改名')}
                            disabled={busy || !!pending}
                            onClick={() => {
                              const value = prompt(t('项目显示名'), p.name);
                              if (value?.trim())
                                void mutate({
                                  operation: 'rename',
                                  id: p.id,
                                  name: value.trim(),
                                });
                            }}
                          />
                          <IconButton
                            icon="trash"
                            label={t('取消注册')}
                            disabled={busy || !!pending}
                            onClick={() => {
                              if (
                                confirm(
                                  t(
                                    '取消注册项目 {0}？不会删除目录或历史；有活动会话时不能移除。',
                                    p.name,
                                  ),
                                )
                              )
                                void mutate({ operation: 'remove', id: p.id });
                            }}
                          />
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {(catalog.canCreate ?? catalog.canManage) ? (
                <div className="project-wizard">
                  {selectedPath ? (
                    <form
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (busy || pending) return;
                        void mutate({
                          operation: 'add',
                          path: selectedPath,
                          ...(name.trim() ? { name: name.trim() } : {}),
                        });
                      }}
                    >
                      <h3>{t('第 2 步 · 确认项目')}</h3>
                      <div className="project-wizard-path">
                        <span>{t('已选目录')}</span>
                        <code>{selectedPath}</code>
                      </div>
                      <label>
                        {t('项目显示名')}
                        <input
                          ref={projectNameInput}
                          value={name}
                          placeholder={t('留空则使用目录名')}
                          maxLength={100}
                          onChange={(event) => setName(event.target.value)}
                          disabled={busy || !!pending}
                        />
                      </label>
                      <p>
                        {t(
                          '新增项目对该 Agent 已授权的使用者可见。文件访问使用 Agent 的系统用户权限。',
                        )}
                      </p>
                      <div className="project-wizard-actions">
                        <button
                          type="button"
                          disabled={busy || !!pending}
                          onClick={() => {
                            setError('');
                            setSelectedPath('');
                            void browse(selectedPath);
                          }}
                        >
                          {t('返回选择目录')}
                        </button>
                        <button
                          className="primary"
                          type="submit"
                          disabled={busy || !!pending}
                        >
                          {t('添加项目')}
                        </button>
                      </div>
                    </form>
                  ) : (
                    <>
                      <h3>{t('第 1 步 · 选择远程目录')}</h3>
                      {directories && (
                        <>
                          <div className="project-wizard-path">
                            <span>{t('当前目录')}</span>
                            <code>{directories.path}</code>
                          </div>
                          <div className="project-wizard-actions">
                            <button
                              type="button"
                              disabled={
                                busy ||
                                !!pending ||
                                !directories.parent ||
                                directories.parent === directories.path
                              }
                              onClick={() => void browse(directories.parent)}
                            >
                              {t('上级目录')}
                            </button>
                            <button
                              type="button"
                              disabled={
                                busy || !!pending || directoryName !== undefined
                              }
                              onClick={() => setDirectoryName('')}
                            >
                              {t('新建子目录')}
                            </button>
                          </div>
                          {directoryName !== undefined && (
                            <form
                              onSubmit={(event) => {
                                event.preventDefault();
                                if (busy || pending || !directoryName.trim())
                                  return;
                                void mutate({
                                  operation: 'mkdir',
                                  path: directories.path,
                                  directoryName: directoryName.trim(),
                                });
                              }}
                            >
                              <p>{t('目录会立即在此主机上创建。')}</p>
                              <label>
                                {t('新目录名称')}
                                <input
                                  required
                                  value={directoryName}
                                  maxLength={255}
                                  onChange={(event) =>
                                    setDirectoryName(event.target.value)
                                  }
                                  disabled={busy || !!pending}
                                />
                              </label>
                              <div className="project-wizard-actions">
                                <button
                                  type="button"
                                  disabled={busy || !!pending}
                                  onClick={() => setDirectoryName(undefined)}
                                >
                                  {t('取消新建目录')}
                                </button>
                                <button
                                  type="submit"
                                  className="primary"
                                  disabled={
                                    busy || !!pending || !directoryName.trim()
                                  }
                                >
                                  {t('创建并选用')}
                                </button>
                              </div>
                            </form>
                          )}
                          <div className="project-directory-list">
                            {directories.directories.map((directory) => (
                              <IconButton
                                icon="folder"
                                label={directory.name}
                                showLabel
                                key={directory.path}
                                disabled={busy || !!pending}
                                onClick={() => void browse(directory.path)}
                              />
                            ))}
                          </div>
                          {!directories.directories.length && (
                            <p>{t('没有子目录')}</p>
                          )}
                          {directories.truncated && (
                            <p>{t('目录过多，请输入更具体的路径')}</p>
                          )}
                          {directoryName === undefined && (
                            <button
                              className="primary"
                              type="button"
                              disabled={busy || !!pending}
                              onClick={() => {
                                setError('');
                                setSelectedPath(directories.path);
                              }}
                            >
                              {t('选用当前目录')}
                            </button>
                          )}
                        </>
                      )}
                      <details>
                        <summary>{t('按路径跳转')}</summary>
                        <form
                          onSubmit={(event) => {
                            event.preventDefault();
                            if (!busy && !pending) void browse(path);
                          }}
                        >
                          <label>
                            {t('远程目录绝对路径')}
                            <input
                              required
                              value={path}
                              maxLength={4096}
                              onChange={(event) => setPath(event.target.value)}
                              disabled={busy || !!pending}
                            />
                          </label>
                          <button
                            type="submit"
                            disabled={busy || !!pending || !path.trim()}
                          >
                            {t('打开目录')}
                          </button>
                        </form>
                      </details>
                    </>
                  )}
                </div>
              ) : (
                <p>{t('当前主机未授予新建项目权限。')}</p>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
export function AgentAdminEmail({
  host,
  saved,
}: {
  host: {
    id: string;
    name: string;
    agentAdminEmail?: string;
    adminEmailOverride?: string;
    approvedAdminEmail?: string;
  };
  saved: () => Promise<void>;
}) {
  const configured =
    host.approvedAdminEmail ??
    host.adminEmailOverride ??
    host.agentAdminEmail ??
    '';
  const [value, setValue] = useState(configured);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => setValue(configured), [configured]);
  async function save(email: string | null) {
    setBusy(true);
    setMessage('');
    try {
      await api(`/admin/hosts/${host.id}/admin-email`, { email });
      await saved();
      setMessage(t('管理员邮箱已保存'));
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  if (host.approvedAdminEmail)
    return (
      <p>
        {t('Agent 管理员邮箱')} · {host.name}: {host.approvedAdminEmail} (
        {t('以批准此 Agent 的邮箱为准')})
      </p>
    );
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save(value);
      }}
    >
      <label>
        {t('Agent 管理员邮箱')} · {host.name}
        <input
          type="email"
          value={value}
          maxLength={254}
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
        />
      </label>
      <button disabled={busy}>{t('保存管理员邮箱')}</button>
      <button
        type="button"
        disabled={busy || host.adminEmailOverride === undefined}
        onClick={() => void save(null)}
      >
        {t('恢复 Agent 管理员配置')}
      </button>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
export function ManagerPairing() {
  const [id, setId] = useState(() =>
    new URLSearchParams(location.hash.slice(1)).get('manager'),
  );
  useEffect(() => {
    const changed = () =>
      setId(new URLSearchParams(location.hash.slice(1)).get('manager'));
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return id ? <ManagerPairingRequest key={id} id={id} /> : null;
}
function ManagerPairingRequest({ id }: { id: string }) {
  const [request, setRequest] = useState<{
    name: string;
    hostName: string;
    hostId: string;
    code: string;
  }>();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    setBusy(true);
    setMessage('');
    try {
      setRequest(await api(`/auth/manager-device/${id}`));
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function decide(decision: string) {
    setBusy(true);
    try {
      await api(`/auth/manager-device/${id}`, { decision, code });
      setRequest(undefined);
      setMessage(t('管理身份配对已处理'));
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <h2>{t('CC 管理身份配对')}</h2>
      <p>
        {t(
          '使用 Agent 管理员邮箱登录，或先登录系统管理员，然后核对终端显示的配对码。',
        )}
      </p>
      <button disabled={busy} onClick={() => void load()}>
        {t('读取管理配对请求')}
      </button>
      {request && (
        <>
          <p>
            {request.name} → {request.hostName} <code>{request.hostId}</code>
          </p>
          <label>
            {t('终端配对码')}
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              maxLength={8}
            />
          </label>
          <button
            disabled={busy || code !== request.code}
            onClick={() => void decide('approve')}
          >
            {t('确认管理身份')}
          </button>
          <button
            disabled={busy || code !== request.code}
            onClick={() => void decide('reject')}
          >
            {t('拒绝')}
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

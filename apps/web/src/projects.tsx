import { IconButton } from './happier/icon-button.tsx';
import { useEffect, useRef, useState } from 'react';
import { api, readApi, queryApi } from './api.ts';
import { observe } from './notifications.ts';
import { HistoryCache } from './history.ts';
import { OperationClient } from './operations.ts';
import { t } from './i18n.ts';

type Project = { id: string; name: string; path: string; available?: boolean };
type Catalog = { revision: number; projects: Project[]; canManage: boolean };
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
  const pathEdited = useRef(false);
  useEffect(() => {
    if (!pathEdited.current) setPath(siblingDirectory(defaultProjectPath));
  }, [defaultProjectPath]);
  const [name, setName] = useState('');
  const [mkdir, setMkdir] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Record<string, unknown>>();
  const [directories, setDirectories] = useState<{
    parent: string;
    directories: { name: string; path: string }[];
    truncated: boolean;
  }>();
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
    void client
      .records()
      .then(async (records) => {
        const original = records.find(
          (record) => record.path === endpoint && record.state !== 'confirmed',
        );
        if (!original) return;
        if (!disposed) {
          setPending(original.body);
          setBusy(true);
        }
        const result = await client.resume(
          original.requestId,
          controller.signal,
        );
        if (disposed) return;
        setCatalog(result);
        setPending(undefined);
        await changed?.();
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      })
      .finally(() => {
        if (!disposed) setBusy(false);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [open, client, endpoint]);
  async function refresh(refreshList = false) {
    setBusy(true);
    setError('');
    try {
      const next: Catalog = await readApi(endpoint);
      setCatalog(next);
      if (!pathEdited.current)
        setPath(siblingDirectory(defaultProjectPath || next.projects[0]?.path));
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
      setCatalog(
        await client.submit(endpoint, request, String(request.requestId), {
          kind: 'project',
        }),
      );
      setPending(undefined);
      if (request.operation === 'add') {
        pathEdited.current = false;
        setPath(siblingDirectory(String(request.path)));
        setName('');
        setDirectories(undefined);
      }
      await changed?.();
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
  async function browse() {
    setBusy(true);
    setError('');
    try {
      setDirectories(await queryApi(endpoint, { operation: 'browse', path }));
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
            icon="plus"
            label={t('新建项目')}
            aria-expanded={open}
            onClick={() => {
              setActivated(true);
              setOpen(!open);
              if (!open) void refresh();
            }}
          />
        ) : (
          <button
            onClick={() => {
              setActivated(true);
              setOpen(!open);
              if (!open) void refresh();
            }}
          >
            {t('项目管理')} · {hostName}
          </button>
        )}
      </div>
      {open && (
        <>
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
              {catalog.canManage ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void mutate({
                      operation: 'add',
                      path,
                      mkdir,
                      ...(name.trim() ? { name: name.trim() } : {}),
                    });
                  }}
                >
                  <p>
                    {t(
                      '新增项目对该 Agent 已授权的使用者可见。文件访问使用 Agent 的系统用户权限。',
                    )}
                  </p>
                  <label>
                    {t('远程目录绝对路径')}
                    <input
                      required
                      value={path}
                      maxLength={4096}
                      onChange={(e) => {
                        pathEdited.current = true;
                        setPath(e.target.value);
                      }}
                      disabled={busy || !!pending}
                    />
                  </label>
                  <IconButton
                    icon="folder"
                    label={t('浏览目录')}
                    type="button"
                    disabled={!path || busy || !!pending}
                    onClick={() => void browse()}
                  />
                  {directories && (
                    <div>
                      <IconButton
                        icon="back"
                        label={t('上级目录')}
                        type="button"
                        onClick={() => {
                          pathEdited.current = true;
                          setPath(directories.parent);
                          setDirectories(undefined);
                        }}
                      />
                      {directories.directories.map((d) => (
                        <button
                          type="button"
                          key={d.path}
                          onClick={() => {
                            pathEdited.current = true;
                            setPath(d.path);
                            setDirectories(undefined);
                          }}
                        >
                          {d.name}
                        </button>
                      ))}
                      {directories.truncated && (
                        <p>{t('目录过多，请输入更具体的路径')}</p>
                      )}
                    </div>
                  )}
                  <label>
                    {t('项目显示名')}
                    <input
                      value={name}
                      maxLength={100}
                      onChange={(e) => setName(e.target.value)}
                      disabled={busy || !!pending}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={mkdir}
                      onChange={(e) => setMkdir(e.target.checked)}
                      disabled={busy || !!pending}
                    />
                    {t('目录不存在时创建')}
                  </label>
                  <IconButton
                    icon="plus"
                    label={t('添加项目')}
                    disabled={busy || !!pending}
                    type="submit"
                  />
                </form>
              ) : (
                <p>{t('仅 Agent 管理员邮箱或系统管理员可以更改项目登记。')}</p>
              )}
            </>
          )}
        </>
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
  };
  saved: () => Promise<void>;
}) {
  const configured = host.adminEmailOverride ?? host.agentAdminEmail ?? '';
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

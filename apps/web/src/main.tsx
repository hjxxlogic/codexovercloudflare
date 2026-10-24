import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Event, Session } from '../../../packages/protocol/src/index.ts';
import './style.css';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { visibleEvents } from './events.ts';

async function api(path: string, data?: unknown): Promise<any> {
  const r = await fetch('/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const b: any = await r.json();
  if (!r.ok) throw new Error(b.error?.code + ': ' + b.error?.message);
  return b;
}
function MenuIcon() {
  return (
    <svg
      className="ui-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  );
}
function CodexMark() {
  return (
    <svg
      className="ui-icon codex-mark"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path d="m12 2 10 10-10 10L2 12Z M8 8l-4 4 4 4m8-8 4 4-4 4m-3-9-2 10" />
    </svg>
  );
}
type Thread = { id: string; preview: string; name?: string; updatedAt: number };
type View = 'chat' | 'connection' | 'devices' | 'keys';
function App() {
  const [view, setView] = useState<View>('chat');
  const [menuOpen, setMenuOpen] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [showSessions, setShowSessions] = useState(true);
  const historyRequest = useRef(0);
  const messageList = useRef<HTMLDivElement>(null);
  const followMessages = useRef(true);
  const menu = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const timer = setTimeout(() => {
      if (!menu.current?.querySelector('nav')?.contains(document.activeElement))
        setMenuOpen(false);
    }, 4000);
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', escape);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('keydown', escape);
    };
  }, [menuOpen]);
  const [logged, setLogged] = useState(false),
    [admin, setAdmin] = useState(false),
    [targetHost, setTargetHost] = useState(''),
    [deviceName, setDeviceName] = useState('网页客户端'),
    [adding, setAdding] = useState(false),
    [checking, setChecking] = useState(true),
    [devices, setDevices] = useState<{ pending: any[]; credentials: any[] }>({
      pending: [],
      credentials: [],
    }),
    [apiKeys, setApiKeys] = useState<any[]>([]),
    [keyHosts, setKeyHosts] = useState<any[]>([]),
    [keyRole, setKeyRole] = useState('agent'),
    [keyName, setKeyName] = useState(''),
    [keyHost, setKeyHost] = useState(''),
    [newKey, setNewKey] = useState(''),
    [managing, setManaging] = useState(''),
    [adminLogin, setAdminLogin] = useState(false),
    [grant, setGrant] = useState<{
      id: string;
      code: string;
      expires: number;
    }>(),
    [generating, setGenerating] = useState(false),
    [secret, setSecret] = useState(''),
    [hosts, setHosts] = useState<any[]>([]),
    [host, setHost] = useState(''),
    [projects, setProjects] = useState<any[]>([]),
    [project, setProject] = useState(''),
    [sessions, setSessions] = useState<Session[]>([]),
    [selected, setSelected] = useState<Session>(),
    [events, setEvents] = useState<Event[]>([]),
    [approvals, setApprovals] = useState<any[]>([]),
    [text, setText] = useState(''),
    [status, setStatus] = useState('未连接'),
    [error, setError] = useState(''),
    [ready, setReady] = useState(false),
    [pending, setPending] = useState(false),
    [busy, setBusy] = useState(false),
    [takeover, setTakeover] = useState(false);
  const projectContext = useRef({ host, project });
  useEffect(() => {
    projectContext.current = { host, project };
  }, [host, project]);
  const socket = useRef<WebSocket | null>(null),
    after = useRef(0);
  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  async function refresh() {
    const results = await Promise.allSettled([api('/hosts'), api('/auth/me')]);
    if (results[0].status === 'fulfilled') {
      const available = results[0].value;
      setHosts(available);
      setLogged(true);
      setHost((current) =>
        available.some((h: any) => h.id === current) ? current : '',
      );
    } else {
      setHosts([]);
      setLogged(false);
      setSelected(undefined);
      setHost('');
    }
    setAdmin(results[1].status === 'fulfilled');
    setChecking(false);
  }
  useEffect(() => {
    const request = new URLSearchParams(location.hash.slice(1)).get(
      'authorize',
    );
    if (request) {
      setView('devices');
      setAdminLogin(true);
      setManaging(request);
      history.replaceState(null, '', location.pathname + location.search);
    }
    void refresh();
  }, []);
  useEffect(() => {
    if (!admin) return;
    let disposed = false;
    const update = () =>
      void Promise.all([
        api('/admin/devices'),
        api('/admin/api-keys'),
        api('/admin/hosts'),
      ])
        .then(([d, keys, available]) => {
          if (!disposed) {
            setDevices(d);
            setApiKeys(keys);
            setKeyHosts(available.filter((h: any) => !h.disabled));
          }
        })
        .catch(report);
    update();
    const timer = setInterval(update, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [admin]);
  useEffect(() => {
    if (!grant) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (grant.expires <= Date.now())
          throw new Error('登录请求已过期，请重新申请');
        const result = await api('/auth/device/poll', { id: grant.id });
        if (disposed) return;
        if (result.state === 'approved') {
          setGrant(undefined);
          setAdding(false);
          setView('chat');
          setHost(result.hostId);
          await refresh();
        } else if (result.state === 'rejected') {
          setGrant(undefined);
          setError('管理员已拒绝登录申请');
        } else timer = setTimeout(() => void poll(), 2000);
      } catch (e) {
        if (!disposed) {
          setGrant(undefined);
          report(e);
        }
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [grant]);
  useEffect(() => {
    let disposed = false;
    setProjects([]);
    setProject('');
    setSessions([]);
    setSelected(undefined);
    if (!host) return;
    void Promise.all([
      api(`/hosts/${host}/projects`),
      api('/sessions?hostId=' + host),
    ])
      .then(([p, s]) => {
        if (disposed) return;
        setProjects(p);
        setProject(p[0]?.id || '');
        setSessions(s);
      })
      .catch((e) => {
        if (!disposed) report(e);
      });
    return () => {
      disposed = true;
    };
  }, [host]);
  async function loadThreads(append = false) {
    if (!host || !project) return;
    const request = ++historyRequest.current;
    setLoadingThreads(true);
    try {
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await api(
            `/hosts/${host}/threads?projectId=${encodeURIComponent(project)}${append && cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
          );
          break;
        } catch (e) {
          if (request !== historyRequest.current) return;
          if (
            attempt >= 3 ||
            !(e instanceof Error) ||
            !e.message.startsWith('BACKPRESSURE:')
          )
            throw e;
          await new Promise((resolve) =>
            setTimeout(resolve, 300 * (attempt + 1)),
          );
        }
      }
      if (request !== historyRequest.current) return;
      setThreads((previous) =>
        append
          ? [
              ...previous,
              ...result.data.filter(
                (t: Thread) => !previous.some((p) => p.id === t.id),
              ),
            ]
          : result.data,
      );
      setCursor(result.nextCursor);
    } catch (e) {
      if (request === historyRequest.current) report(e);
    } finally {
      if (request === historyRequest.current) setLoadingThreads(false);
    }
  }
  useEffect(() => {
    setThreads([]);
    setCursor(null);
    setSearch('');
    void loadThreads();
    return () => {
      historyRequest.current++;
    };
  }, [host, project]);
  useEffect(() => {
    if (followMessages.current && messageList.current)
      messageList.current.scrollTop = messageList.current.scrollHeight;
  }, [events, view]);
  useEffect(() => {
    setReady(false);
    setEvents([]);
    setApprovals([]);
    setText('');
    followMessages.current = true;
    if (!selected) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>,
      attempt = 0;
    after.current = 0;
    setEvents([]);
    setApprovals([]);
    setReady(false);
    setPending(false);
    setBusy(selected.running);
    const seen = new Set<number>();
    let stateSeq = 0;
    const add = (e: Event) => {
      if (seen.has(e.seq)) return;
      seen.add(e.seq);
      after.current = Math.max(after.current, e.seq);
      setEvents((v) => [...v, e].sort((a, b) => a.seq - b.seq).slice(-1000));
      const d = e.data as any;
      if (e.type === 'sessionClosed') {
        setReady(false);
        setSessions((v) =>
          v.map((s) =>
            s.id === selected.id ? { ...s, state: d.state, running: false } : s,
          ),
        );
      }
      if (e.type === 'approval')
        setApprovals((v) => [
          ...v.filter((a) => a.approvalId !== d.approvalId),
          d,
        ]);
      if (e.type === 'approvalResolved')
        setApprovals((v) => v.filter((a) => a.approvalId !== d.approvalId));
      if (
        e.seq > stateSeq &&
        ['turn/started', 'turn/completed', 'sessionClosed'].includes(e.type)
      ) {
        stateSeq = e.seq;
        setBusy(e.type === 'turn/started');
      }
    };
    const connect = async () => {
      setStatus(attempt ? '正在重连' : '正在连接');
      setReady(false);
      try {
        const t = await api(
          `/sessions/${selected.id}/${takeover ? 'takeover' : 'attach'}`,
          {},
        );
        if (disposed) return;
        const ws = new WebSocket(
          location.origin.replace(/^http/, 'ws') + '/ws/v1/web/' + selected.id,
        );
        socket.current = ws;
        ws.onopen = () =>
          ws.send(JSON.stringify({ type: 'auth', ticket: t.ticket }));
        ws.onmessage = (message) => {
          if (disposed) return;
          try {
            const d = JSON.parse(message.data);
            if (d.type === 'attached') {
              ws.send(JSON.stringify({ action: 'sync', after: after.current }));
              return;
            }
            if (d.type === 'sync') {
              setApprovals(d.approvals);
              setBusy(d.session.running);
              for (const e of d.events) add(e);
              if (d.gap) setError('部分历史已清理，当前显示保留记录。');
              if (d.more)
                ws.send(
                  JSON.stringify({ action: 'sync', after: after.current }),
                );
              else {
                setReady(true);
                setStatus('已连接');
                attempt = 0;
                setPending(false);
              }
              return;
            }
            if (d.type === 'event') add(d.event);
            if (d.type === 'ack') setPending(false);
            if (d.type === 'error') {
              setPending(false);
              setError(d.error.code + ': ' + d.error.message);
            }
          } catch (e) {
            report(e);
          }
        };
        ws.onclose = (e) => {
          if (disposed) return;
          setReady(false);
          setPending(false);
          setStatus('已断开');
          if (e.code === 4009) {
            setError('控制权已被其他设备接管');
            return;
          }
          if (e.code === 4001) {
            setError('登录已过期或被撤销，请重新登录');
            return;
          }
          timer = setTimeout(
            () => void connect(),
            Math.min(15000, 1000 * 2 ** attempt++),
          );
        };
        ws.onerror = () => {
          if (!disposed) setStatus('连接错误');
        };
      } catch (e) {
        if (!disposed) {
          report(e);
          setStatus('无法连接');
        }
      }
    };
    void connect();
    return () => {
      disposed = true;
      clearTimeout(timer);
      socket.current?.close();
      socket.current = null;
    };
  }, [selected?.id, takeover]);
  const send = (data: unknown) => {
    if (socket.current?.readyState !== WebSocket.OPEN || !ready) return;
    setPending(true);
    socket.current.send(
      JSON.stringify({ ...(data as object), requestId: crypto.randomUUID() }),
    );
  };
  async function login(e: React.FormEvent) {
    e.preventDefault();
    setGenerating(true);
    setError('');
    try {
      if (adminLogin) {
        await api('/auth/login', { secret });
        setSecret('');
        await refresh();
        setView('devices');
      } else {
        const result = await api('/auth/device/start', {
          role: 'web',
          name: deviceName,
          hostId: targetHost,
        });
        setGrant(result);
      }
    } catch (e) {
      report(e);
    } finally {
      setGenerating(false);
    }
  }
  async function manage(action: 'approve' | 'reject' | 'revoke', id: string) {
    if (
      action === 'revoke' &&
      !confirm('撤销此凭证？撤销 A 会使其所有客户端授权失效，并关闭相关连接。')
    )
      return;
    setGenerating(true);
    setError('');
    try {
      await api('/admin/' + action, { id });
      setDevices(await api('/admin/devices'));
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setGenerating(false);
    }
  }
  async function create(threadId?: string) {
    if (creating) return;
    const existing = sessions.find(
      (s) => s.threadId === threadId && s.state === 'ready',
    );
    if (threadId && existing) {
      if (existing.mode !== 'web') {
        setError('此线程正在 CLI 会话中使用，请先结束原会话。');
        return;
      }
      setTakeover(false);
      setSelected(existing);
      return;
    }
    setCreating(true);
    try {
      setError('');
      const s = await api('/sessions', {
        hostId: host,
        projectId: project,
        mode: 'web',
        ...(threadId ? { threadId } : {}),
      });
      if (
        projectContext.current.host !== host ||
        projectContext.current.project !== project
      )
        return;
      setSessions((v) => [s, ...v]);
      setTakeover(false);
      setSelected(s);
      void loadThreads();
    } catch (e) {
      report(e);
    } finally {
      setCreating(false);
    }
  }
  return (
    <main>
      <header className="topbar" ref={menu}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView('chat');
          }}
        >
          <CodexMark /> <span>远程 Codex</span>
          <small>CW 工作台</small>
        </a>
        <button
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="feature-menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MenuIcon /> 功能菜单
        </button>
        {menuOpen && (
          <nav
            id="feature-menu"
            aria-label="功能菜单"
            onMouseLeave={() => setMenuOpen(false)}
          >
            {(
              [
                ['chat', 'CW 对话', '会话与远程任务'],
                ['connection', '连接设置', '主机、项目与登录'],
                ['devices', '设备授权', '审批与管理设备'],
                ['keys', 'API Key', '管理访问凭证'],
              ] as const
            ).map(([id, label, description]) => (
              <button
                key={id}
                aria-current={view === id ? 'page' : undefined}
                onClick={() => {
                  setView(id);
                  setMenuOpen(false);
                  if ((id === 'devices' || id === 'keys') && !admin)
                    setAdminLogin(true);
                }}
              >
                <strong>{label}</strong>
                <small>{description}</small>
              </button>
            ))}
          </nav>
        )}
      </header>
      <div className="page-heading">
        <span>
          {
            {
              chat: 'CW 对话',
              connection: '连接设置',
              devices: '设备授权',
              keys: 'API Key 管理',
            }[view]
          }
        </span>
        <small>
          {hosts.find((h) => h.id === host)?.name || '选择远程主机开始工作'}
        </small>
      </div>
      {error && (
        <div role="alert" className="error">
          {error}
          <button onClick={() => setError('')}>关闭</button>
        </div>
      )}
      {view === 'connection' && (
        <section className="card">
          <h2>登录与授权</h2>{' '}
          <div className="row">
            <button
              onClick={() => {
                setAdminLogin((v) => !v);
                setSecret('');
              }}
            >
              {adminLogin ? '连接 A' : '管理员登录'}
            </button>
            {logged && (
              <button
                onClick={() => {
                  setAdding((v) => !v);
                  setAdminLogin(false);
                }}
              >
                添加 A 授权
              </button>
            )}
            {admin && (
              <button
                onClick={() =>
                  void api('/auth/logout', {})
                    .then(() => {
                      setAdmin(false);
                      setNewKey('');
                      setAdminLogin(false);
                    })
                    .catch(report)
                }
              >
                退出管理
              </button>
            )}
          </div>
        </section>
      )}
      {checking && <p role="status">正在检查登录状态…</p>}
      {!checking &&
        (view !== 'chat' || !logged) &&
        (adminLogin ? !admin : !logged || adding) && (
          <form onSubmit={login} className="card">
            <h2>{adminLogin ? '管理员登录' : '连接指定 A'}</h2>
            {adminLogin ? (
              <label>
                所有者密钥
                <input
                  aria-label="所有者密钥"
                  type="password"
                  required
                  autoComplete="current-password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </label>
            ) : (
              <>
                <label>
                  A 标识
                  <input
                    aria-label="A 标识"
                    required
                    value={targetHost}
                    onChange={(e) => setTargetHost(e.target.value)}
                  />
                </label>
                <label>
                  设备名称
                  <input
                    aria-label="设备名称"
                    required
                    maxLength={100}
                    value={deviceName}
                    onChange={(e) => setDeviceName(e.target.value)}
                  />
                </label>
              </>
            )}
            <button
              type="submit"
              disabled={generating || (!adminLogin && !!grant)}
            >
              {adminLogin ? '登录' : '申请登录'}
            </button>
            {grant && (
              <div role="status">
                <p>
                  等待管理员批准，配对码：<strong>{grant.code}</strong>
                </p>
                <p>请求：{grant.id}</p>
                <p>有效期至 {new Date(grant.expires).toLocaleString()}</p>
              </div>
            )}
            <p>
              每份网页凭证仅访问一个 A，可保留多个 A
              的授权；批准后长期有效，直到 R 撤销。
            </p>
          </form>
        )}
      {admin && view === 'devices' && (
        <section className="card">
          <h2>设备授权管理</h2>
          <p>
            批准前请与申请方核对配对码、角色和目标 A。管理身份不能直接操作 Codex
            会话。
          </p>
          {managing && <p>当前请求：{managing}</p>}
          <h3>待授权请求</h3>
          {!devices.pending.length && <p>暂无待授权请求</p>}
          {devices.pending.map((d) => (
            <div className="card" key={d.id}>
              <p>
                {d.name} ·{' '}
                {d.role === 'agent' ? 'A' : d.role === 'cli' ? 'CC' : 'CW'} ·
                配对码 {d.code}
              </p>
              <p>目标 A：{d.hostId}</p>
              <p>
                请求：{d.id} · 有效期至 {new Date(d.expires).toLocaleString()}
              </p>
              <button
                disabled={generating}
                onClick={() => void manage('approve', d.id)}
              >
                批准 {d.code}
              </button>
              <button
                disabled={generating}
                onClick={() => void manage('reject', d.id)}
              >
                拒绝 {d.code}
              </button>
            </div>
          ))}
          <h3>已授权设备</h3>
          {devices.credentials.map((d) => (
            <div className="card" key={d.id}>
              <p>
                {d.name} ·{' '}
                {d.role === 'agent' ? 'A' : d.role === 'cli' ? 'CC' : 'CW'} ·
                A：{d.hostId}
              </p>
              <p>授权时间：{new Date(d.created).toLocaleString()} · 长期有效</p>
              <button
                disabled={generating}
                onClick={() => void manage('revoke', d.id)}
              >
                撤销 {d.name}
              </button>
            </div>
          ))}
        </section>
      )}
      {admin && view === 'keys' && (
        <section className="card">
          <h2>API Key 管理</h2>
          <p>
            Key 本身就是长期访问凭证，直到从 R 撤销。角色与目标 A
            不可修改；请妥善保管。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setGenerating(true);
              setNewKey('');
              void api('/admin/api-keys', {
                role: keyRole,
                name: keyName,
                hostId: keyHost,
              })
                .then(async (result) => {
                  setNewKey(result.apiKey);
                  setApiKeys(await api('/admin/api-keys'));
                })
                .catch(report)
                .finally(() => setGenerating(false));
            }}
          >
            <label>
              Key 名称
              <input
                aria-label="Key 名称"
                required
                maxLength={100}
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </label>
            <label>
              使用程序
              <select
                aria-label="使用程序"
                value={keyRole}
                onChange={(e) => setKeyRole(e.target.value)}
              >
                <option value="agent">coc-agent</option>
                <option value="cli">coc-client</option>
              </select>
            </label>
            {keyRole === 'cli' ? (
              <label>
                目标 A
                <select
                  aria-label="Key 目标 A"
                  required
                  value={keyHost}
                  onChange={(e) => setKeyHost(e.target.value)}
                >
                  <option value="">请选择 A</option>
                  {keyHosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} · {h.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p>A Key 在首次登录时创建并永久绑定自己的 A。</p>
            )}
            <button disabled={generating}>生成 API_KEY</button>
          </form>
          {newKey && (
            <div className="card">
              <p>仅显示这一次，请保存：</p>
              <input aria-label="新 API_KEY" readOnly value={newKey} />
              <button
                onClick={() =>
                  void navigator.clipboard.writeText(newKey).catch(report)
                }
              >
                复制 API_KEY
              </button>
              <button onClick={() => setNewKey('')}>隐藏 API_KEY</button>
            </div>
          )}
          {apiKeys.map((k) => (
            <div className="card" key={k.id}>
              <p>
                {k.name} · {k.role === 'agent' ? 'coc-agent' : 'coc-client'} ·
                A：{k.hostId || '等待首次使用绑定'}
              </p>
              <p>创建于 {new Date(k.created).toLocaleString()} · 长期有效</p>
              <button
                disabled={generating}
                onClick={() => {
                  if (
                    !confirm(
                      k.role === 'agent' && k.hostId
                        ? '撤销此 A Key 将停用 A，并撤销其全部客户端授权。继续？'
                        : '撤销此 API Key？',
                    )
                  )
                    return;
                  setGenerating(true);
                  void api('/admin/api-keys/revoke', { id: k.id })
                    .then(async () => {
                      setNewKey('');
                      setApiKeys(await api('/admin/api-keys'));
                      setDevices(await api('/admin/devices'));
                    })
                    .catch(report)
                    .finally(() => setGenerating(false));
                }}
              >
                撤销 Key {k.name}
              </button>
            </div>
          ))}
        </section>
      )}
      {logged && (view === 'chat' || view === 'connection') && (
        <>
          <section className="card project-picker">
            <h2>选择远程项目</h2>
            <div className="row">
              <label>
                主机
                <select
                  aria-label="主机"
                  value={host}
                  onChange={(e) => {
                    setSelected(undefined);
                    setHost(e.target.value);
                  }}
                >
                  <option value="">请选择</option>
                  {hosts.map((h) => (
                    <option key={h.id} value={h.id} disabled={!h.online}>
                      {h.name} · {h.online ? '在线' : '离线'}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                项目
                <select
                  aria-label="项目"
                  value={project}
                  onChange={(e) => {
                    setSelected(undefined);
                    setProject(e.target.value);
                  }}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.path}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => void refresh()}>刷新主机</button>
              {view === 'connection' && (
                <button
                  disabled={!host}
                  onClick={() => {
                    if (
                      confirm(
                        '移除此 A 的本地凭证？R 上的授权保持不变，已有任务不会停止。',
                      )
                    )
                      void api('/auth/forget', { hostId: host })
                        .then(() => {
                          socket.current?.close();
                          setSelected(undefined);
                          return refresh();
                        })
                        .catch(report);
                  }}
                >
                  移除本地授权
                </button>
              )}
              <button
                disabled={!host || !project || creating}
                onClick={() => {
                  setView('chat');
                  void create();
                }}
              >
                创建网页会话
              </button>
            </div>
          </section>
          {view === 'chat' && (
            <div className={`layout ${showSessions ? '' : 'sidebar-hidden'}`}>
              <aside className="card session-sidebar" hidden={!showSessions}>
                <div className="row sidebar-title">
                  <h2>会话记录</h2>
                  <button
                    aria-label="收起会话列表"
                    onClick={() => setShowSessions(false)}
                  >
                    ‹
                  </button>
                </div>
                <button
                  className="new-chat"
                  disabled={!host || !project || creating}
                  onClick={() => void create()}
                >
                  ＋ 新建对话
                </button>
                <input
                  className="session-search"
                  aria-label="搜索会话"
                  placeholder="搜索已加载的会话…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <button
                  disabled={!host || loadingThreads}
                  onClick={() => {
                    void loadThreads();
                    void api('/sessions?hostId=' + host)
                      .then(setSessions)
                      .catch(report);
                  }}
                >
                  {loadingThreads ? '正在加载…' : '刷新会话'}
                </button>
                <p className="sidebar-caption">
                  与远程 Codex 共用历史 · 当前项目
                </p>
                {sessions
                  .filter(
                    (s) =>
                      s.projectId === project &&
                      s.mode === 'web' &&
                      s.state === 'ready' &&
                      !threads.some((t) => t.id === s.threadId),
                  )
                  .filter((s) => s.id.includes(search))
                  .map((s) => (
                    <button
                      className={`session ${selected?.id === s.id ? 'active' : ''}`}
                      key={s.id}
                      onClick={() => {
                        setTakeover(false);
                        setSelected(s);
                      }}
                    >
                      进行中的对话
                      <small>{new Date(s.createdAt).toLocaleString()}</small>
                    </button>
                  ))}
                {threads
                  .filter((t) =>
                    `${t.name || ''} ${t.preview} ${t.id}`
                      .toLowerCase()
                      .includes(search.toLowerCase()),
                  )
                  .map((t) => (
                    <button
                      className={`session ${selected?.threadId === t.id ? 'active' : ''}`}
                      key={t.id}
                      disabled={creating}
                      onClick={() => void create(t.id)}
                      title={t.preview || t.id}
                    >
                      <span>{t.name || t.preview || '未命名对话'}</span>
                      <small>
                        {new Date(t.updatedAt * 1000).toLocaleString()}
                        {selected?.threadId === t.id ? ' · 当前对话' : ''}
                      </small>
                    </button>
                  ))}
                {!loadingThreads && !threads.length && (
                  <p className="empty-hint">
                    {host && project
                      ? '暂无本地历史，创建新对话开始。'
                      : '请先选择主机与项目。'}
                  </p>
                )}
                {cursor && (
                  <button
                    disabled={loadingThreads}
                    onClick={() => void loadThreads(true)}
                  >
                    加载更多
                  </button>
                )}
              </aside>
              <section className="card conversation">
                <div className="conversation-heading">
                  <button
                    aria-label={showSessions ? '收起会话列表' : '展开会话列表'}
                    onClick={() => setShowSessions((v) => !v)}
                  >
                    <MenuIcon />
                  </button>
                  <h2>
                    {threads.find((t) => t.id === selected?.threadId)?.name ||
                      'Codex 对话'}
                  </h2>
                  <small>{selected ? status : '准备就绪'}</small>
                </div>
                {selected ? (
                  <>
                    <p className="status">
                      {status} · {busy ? '执行中' : '空闲'} · 远程项目{' '}
                      {selected.projectId}
                    </p>
                    <p className="id">{selected.id}</p>
                    <div className="row">
                      <button
                        disabled={!ready || pending || !busy}
                        onClick={() => send({ action: 'interrupt' })}
                      >
                        停止本轮
                      </button>
                      <button
                        onClick={() => {
                          if (confirm('结束会话？已修改文件不会回滚。'))
                            void api(`/sessions/${selected.id}/stop`, {})
                              .then((closed: Session) => {
                                setSessions((v) =>
                                  v.map((s) =>
                                    s.id === closed.id ? closed : s,
                                  ),
                                );
                                setSelected(undefined);
                                setStatus('会话已结束');
                              })
                              .catch(report);
                        }}
                      >
                        结束会话
                      </button>
                      <button
                        onClick={() => {
                          if (confirm('接管会断开其他控制端，继续？'))
                            setTakeover((v) => !v);
                        }}
                      >
                        重新连接 / 接管
                      </button>
                    </div>
                    <div
                      className="messages"
                      ref={messageList}
                      role="log"
                      aria-label="对话消息"
                      aria-live="polite"
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        followMessages.current =
                          el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                      }}
                    >
                      {visibleEvents(events).map((e) => {
                        const isChat =
                          e.type === 'user' ||
                          e.type === 'item/agentMessage/delta';
                        return isChat ? (
                          <article
                            className={`message ${e.type === 'user' ? 'user-message' : 'assistant-message'}`}
                            key={e.seq}
                          >
                            <strong className="message-role">
                              {eventTitle(e)}
                            </strong>
                            {e.type === 'user' ? (
                              <div className="user-text">{eventText(e)}</div>
                            ) : (
                              <div className="markdown">
                                <Markdown
                                  remarkPlugins={[remarkGfm]}
                                  components={{
                                    a: ({ children, ...props }) => (
                                      <a
                                        {...props}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        {children}
                                      </a>
                                    ),
                                    img: ({ alt }) => (
                                      <span>[图片：{alt}]</span>
                                    ),
                                  }}
                                >
                                  {eventText(e)}
                                </Markdown>
                              </div>
                            )}
                          </article>
                        ) : (
                          <details className="tool-output" key={e.seq}>
                            <summary>{eventTitle(e)}</summary>
                            <pre>{eventText(e)}</pre>
                          </details>
                        );
                      })}
                      {busy && (
                        <p className="thinking" role="status">
                          ● Codex 正在处理…
                        </p>
                      )}
                      {!events.length && (
                        <p className="empty-hint">对话已就绪，发送任务开始。</p>
                      )}
                    </div>
                    {approvals.map((a) => (
                      <section className="approval" key={a.approvalId}>
                        <h3>等待审批</h3>
                        <pre>{JSON.stringify(a.params, null, 2)}</pre>
                        <button
                          disabled={!ready || pending}
                          onClick={() =>
                            send({
                              action: 'approval',
                              approvalId: a.approvalId,
                              allow: true,
                            })
                          }
                        >
                          允许
                        </button>
                        <button
                          disabled={!ready || pending}
                          onClick={() =>
                            send({
                              action: 'approval',
                              approvalId: a.approvalId,
                              allow: false,
                            })
                          }
                        >
                          拒绝
                        </button>
                      </section>
                    ))}
                    <form
                      className="composer"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (text.trim() && ready && !pending && !busy) {
                          send({ action: 'prompt', text });
                          setText('');
                        }
                      }}
                    >
                      <label>
                        任务内容
                        <textarea
                          aria-label="任务内容"
                          value={text}
                          onKeyDown={(e) => {
                            if (
                              e.key === 'Enter' &&
                              !e.shiftKey &&
                              !e.nativeEvent.isComposing
                            ) {
                              e.preventDefault();
                              e.currentTarget.form?.requestSubmit();
                            }
                          }}
                          onChange={(e) => setText(e.target.value)}
                          maxLength={64000}
                          placeholder="描述要在远程项目中完成的任务"
                        />
                      </label>
                      <button
                        type="submit"
                        disabled={!ready || pending || busy || !text.trim()}
                      >
                        发送
                      </button>
                      <small>Enter 发送 · Shift + Enter 换行</small>
                    </form>
                  </>
                ) : (
                  <div className="chat-welcome">
                    <div className="welcome-icon">
                      <CodexMark />
                    </div>
                    <h2>今天要一起完成什么？</h2>
                    <p>恢复 Codex 本地会话，或在远程项目中开始新对话。</p>
                    <button
                      disabled={!host || !project || creating}
                      onClick={() => void create()}
                    >
                      ＋ 开始新对话
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
      <footer>文件和命令在远程服务器执行。关闭页面不会立即停止任务。</footer>
    </main>
  );
}
function eventTitle(e: Event) {
  return (
    (
      {
        user: '你',
        'item/agentMessage/delta': 'Codex',
        'turn/started': '开始任务',
        'turn/completed': '本轮结束',
        'turn/diff/updated': '代码差异',
        'turn/plan/updated': '执行计划',
        'item/started': '工具操作',
        'item/completed': '工具结果',
        'item/commandExecution/outputDelta': '命令输出',
        'item/fileChange/outputDelta': '文件变更',
        warning: '提示',
        error: '错误',
        approvalResolved: '审批结果',
        sessionClosed: '会话结束',
      } as Record<string, string>
    )[e.type] || '任务活动'
  );
}
function eventText(e: Event): string {
  const d = e.data as any;
  if (e.type === 'turn/started') return '任务已开始。';
  if (e.type === 'turn/completed')
    return d.turn?.status === 'completed'
      ? '任务已完成。'
      : '任务已停止或失败：' +
          (d.turn?.error?.message || d.turn?.status || '未知状态');
  if (e.type === 'approvalResolved')
    return d.allow ? '已允许该操作。' : '已拒绝该操作。';
  if (e.type === 'sessionClosed') return '会话已结束：' + d.state;
  if (e.type === 'turn/plan/updated')
    return (
      (d.explanation || '') +
      '\n' +
      (d.plan || [])
        .map((step: any) => step.status + ' · ' + step.step)
        .join('\n')
    );
  if (['item/started', 'item/completed'].includes(e.type))
    return d.item?.command
      ? [
          d.item.command,
          d.item.aggregatedOutput,
          d.item.exitCode != null ? '退出码：' + d.item.exitCode : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : JSON.stringify(d.item || {}, null, 2);
  return (
    d.text ||
    d.delta ||
    d.diff ||
    d.message ||
    d.error?.message ||
    '状态已更新。'
  );
}
createRoot(document.getElementById('root')!).render(<App />);

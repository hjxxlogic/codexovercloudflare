import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Event, Session } from '../../../packages/protocol/src/index.ts';
import './style.css';
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
function App() {
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
      void api('/admin/devices')
        .then((d) => {
          if (!disposed) setDevices(d);
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
  useEffect(() => {
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
  async function create() {
    try {
      setError('');
      const s = await api('/sessions', {
        hostId: host,
        projectId: project,
        mode: 'web',
      });
      setSessions((v) => [s, ...v]);
      setSelected(s);
    } catch (e) {
      report(e);
    }
  }
  return (
    <main>
      <header>
        <div>
          <small>r.xlogic.cc</small>
          <h1>远程 Codex</h1>
        </div>
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
                    setAdminLogin(false);
                  })
                  .catch(report)
              }
            >
              退出管理
            </button>
          )}
        </div>
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
          <button onClick={() => setError('')}>关闭</button>
        </div>
      )}
      {checking && <p role="status">正在检查登录状态…</p>}
      {!checking && (adminLogin ? !admin : !logged || adding) && (
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
            每份网页凭证仅访问一个 A，可保留多个 A 的授权；批准后长期有效，直到
            R 撤销。
          </p>
        </form>
      )}
      {admin && (
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
      {logged && (
        <>
          <section className="card">
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
                  onChange={(e) => setProject(e.target.value)}
                >
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} — {p.path}
                    </option>
                  ))}
                </select>
              </label>
              <button onClick={() => void refresh()}>刷新主机</button>
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
              <button
                disabled={!host || !project}
                onClick={() => void create()}
              >
                创建网页会话
              </button>
            </div>
          </section>
          <div className="layout">
            <aside className="card">
              <h2>会话</h2>
              <button
                disabled={!host}
                onClick={() =>
                  void api('/sessions?hostId=' + host)
                    .then(setSessions)
                    .catch(report)
                }
              >
                刷新会话
              </button>
              {sessions.map((s) => (
                <button
                  className="session"
                  key={s.id}
                  disabled={s.mode !== 'web' || s.state !== 'ready'}
                  onClick={() => {
                    setTakeover(false);
                    setSelected(s);
                  }}
                >
                  {s.id.split('~')[1]?.slice(0, 8)} · {s.mode} · {s.state}
                </button>
              ))}
            </aside>
            <section className="card conversation">
              <h2>任务</h2>
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
                            .then(() => {
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
                  <div className="messages" aria-live="polite">
                    {visibleEvents(events).map((e) => (
                      <article key={e.seq}>
                        <strong>{eventTitle(e)}</strong>
                        <pre>{eventText(e)}</pre>
                      </article>
                    ))}
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
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (text.trim()) {
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
                  </form>
                </>
              ) : (
                <p>选择一个会话或创建新会话。</p>
              )}
            </section>
          </div>
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
  if (e.type === 'item/started')
    return (
      d.item?.command ||
      JSON.stringify(d.item?.changes || d.item?.tool || {}, null, 2)
    );
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

import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Event, Session } from '../../../packages/protocol/src/index.ts';
import './style.css';

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
    [loginCode, setLoginCode] = useState(''),
    [adminLogin, setAdminLogin] = useState(false),
    [grant, setGrant] = useState<{
      code: string;
      url: string;
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
    try {
      setHosts(await api('/hosts'));
      setAdmin((await api('/auth/me')).role === 'owner');
      setLogged(true);
    } catch {
      setLogged(false);
    }
  }
  useEffect(() => {
    const code = new URLSearchParams(location.hash.slice(1)).get('login');
    if (code) {
      setLoginCode(code);
      history.replaceState(null, '', location.pathname + location.search);
    }
    void refresh();
  }, []);
  useEffect(() => {
    if (!host) return;
    setProjects([]);
    setProject('');
    setSessions([]);
    void Promise.all([
      api(`/hosts/${host}/projects`),
      api('/sessions?hostId=' + host),
    ])
      .then(([p, s]) => {
        setProjects(p);
        setProject(p[0]?.id || '');
        setSessions(s);
      })
      .catch(report);
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
    const add = (e: Event) => {
      if (seen.has(e.seq)) return;
      seen.add(e.seq);
      after.current = Math.max(after.current, e.seq);
      setEvents((v) => [...v.slice(-999), e]);
      const d = e.data as any;
      if (e.type === 'approval')
        setApprovals((v) => [
          ...v.filter((a) => a.approvalId !== d.approvalId),
          d,
        ]);
      if (e.type === 'approvalResolved')
        setApprovals((v) => v.filter((a) => a.approvalId !== d.approvalId));
      if (e.type === 'turn/started') setBusy(true);
      if (['turn/completed', 'sessionClosed'].includes(e.type)) setBusy(false);
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
          setReady(false);
          setPending(false);
          setStatus('已断开');
          if (disposed) return;
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
        ws.onerror = () => setStatus('连接错误');
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
    setError('');
    try {
      await api(
        adminLogin ? '/auth/login' : '/auth/redeem',
        adminLogin ? { secret } : { code: loginCode, kind: 'web' },
      );
      setSecret('');
      setLoginCode('');
      await refresh();
    } catch (e) {
      report(e);
    }
  }
  async function generateLogin() {
    setGenerating(true);
    setError('');
    setGrant(undefined);
    try {
      const result = await api('/auth/codes', {});
      setGrant({ ...result, url: new URL(result.url, location.origin).href });
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
        {logged && (
          <button
            onClick={() =>
              void api('/auth/logout', {})
                .then(() => {
                  socket.current?.close();
                  setSelected(undefined);
                  setLogged(false);
                  setAdmin(false);
                  setGrant(undefined);
                })
                .catch(report)
            }
          >
            退出登录
          </button>
        )}
      </header>
      {error && (
        <div role="alert" className="error">
          {error}
          <button onClick={() => setError('')}>关闭</button>
        </div>
      )}
      {!logged ? (
        <form onSubmit={login} className="card">
          <h2>登录中转</h2>
          <label>
            {adminLogin ? '所有者密钥' : '一次性验证码'}
            <input
              aria-label={adminLogin ? '所有者密钥' : '一次性验证码'}
              type="password"
              required
              value={adminLogin ? secret : loginCode}
              onChange={(e) =>
                adminLogin
                  ? setSecret(e.target.value)
                  : setLoginCode(e.target.value)
              }
              autoComplete={adminLogin ? 'current-password' : 'one-time-code'}
            />
          </label>
          <button type="submit">登录</button>
          <button
            type="button"
            onClick={() => {
              setAdminLogin((v) => !v);
              setSecret('');
            }}
          >
            {adminLogin ? '使用验证码登录' : '管理员登录'}
          </button>
          <p>一次性链接或验证码由管理员提供，5 分钟内有效；点击登录后使用。</p>
          <p>模型账号与代码保留在远程服务器。</p>
        </form>
      ) : (
        <>
          {admin && (
            <section className="card">
              <h2>客户端登录授权</h2>
              <button
                disabled={generating}
                onClick={() => void generateLogin()}
              >
                生成一次性登录授权
              </button>
              <p>
                验证码供 coc login
                使用，链接供浏览器使用。两者共用一次授权，任选一种；登录后可操作所有已登记主机和项目，仅分享给可信用户。
              </p>
              {grant && (
                <div>
                  <p>有效期至 {new Date(grant.expires).toLocaleString()}</p>
                  <label>
                    coc 一次性验证码
                    <input
                      aria-label="coc 一次性验证码"
                      readOnly
                      value={grant.code}
                    />
                  </label>
                  <label>
                    浏览器登录链接
                    <input
                      aria-label="浏览器登录链接"
                      readOnly
                      value={grant.url}
                    />
                  </label>
                </div>
              )}
            </section>
          )}
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
function visibleEvents(events: Event[]) {
  const visible = new Set([
    'user',
    'item/agentMessage/delta',
    'turn/started',
    'turn/completed',
    'turn/diff/updated',
    'turn/plan/updated',
    'item/commandExecution/outputDelta',
    'item/fileChange/outputDelta',
    'item/started',
    'warning',
    'error',
    'approvalResolved',
    'sessionClosed',
  ]);
  const result: Event[] = [];
  for (const event of events) {
    if (!visible.has(event.type)) continue;
    if (
      event.type === 'item/started' &&
      !['commandExecution', 'fileChange', 'mcpToolCall'].includes(
        (event.data as any)?.item?.type,
      )
    )
      continue;
    const previous = result.at(-1);
    if (event.type.endsWith('/delta') || event.type.endsWith('/outputDelta')) {
      if (
        previous?.type === event.type &&
        (previous.data as any).itemId === (event.data as any).itemId
      ) {
        result[result.length - 1] = {
          ...previous,
          data: {
            ...(event.data as object),
            delta:
              ((previous.data as any).delta || '') +
              ((event.data as any).delta || ''),
          },
        };
        continue;
      }
    }
    result.push(event);
  }
  return result;
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

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Event, Session } from '../../../packages/protocol/src/index.ts';
import './style.css';
import { eventWindow, mergeEvents } from './events.ts';
import { api, ApiError, retryable } from './api.ts';
import { ApprovalQueue, WorkspaceHeader } from './workspace.tsx';
import {
  ConversationView,
  CopyText,
  type ContentChunk,
} from './conversation.tsx';
import { WorkspaceFiles } from './files.tsx';
import { HistoryCache, type HistoryPage } from './history.ts';
import { SessionHistory, type Thread } from './session-history.tsx';

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
type View = 'chat' | 'connection' | 'devices' | 'keys';
type Mode = 'cw' | 'admin';
function App() {
  const [view, setView] = useState<View>('chat');
  const [mode, setMode] = useState<Mode>('cw');
  const adminLogin = mode === 'admin';
  const currentMode = useRef(mode);
  currentMode.current = mode;
  const [menuOpen, setMenuOpen] = useState(false);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<'sessions' | 'details' | 'files' | null>(
    null,
  );
  const panelDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = panelDialog.current;
    if (panel && dialog && !dialog.open) dialog.showModal();
    else if (!panel && dialog?.open) dialog.close();
  }, [panel]);
  const historyRequest = useRef(0);
  const historySocket = useRef<WebSocket | null>(null);
  const localHistory = useRef<HistoryCache | null>(null);
  const catalog = useRef<HistoryCache | null>(null);
  const olderView = useRef(false);
  const loadContent = useRef<
    (seq: number, offset: number, revision: number) => void
  >(() => {});
  const loadHistory = useRef<(before?: number) => void>(() => {});
  const [olderCursor, setOlderCursor] = useState(0);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historyNotice, setHistoryNotice] = useState('');
  const [contentChunks, setContentChunks] = useState<
    Record<number, ContentChunk>
  >({});
  const [readingContent, setReadingContent] = useState<Record<number, boolean>>(
    {},
  );
  const messageList = useRef<HTMLDivElement>(null);
  const messageScrollTop = useRef(0);
  const historyAnchor = useRef<{ seq: string; top: number } | null>(null);
  const followMessages = useRef(true);
  const menu = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
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
  const [createOperation, setCreateOperation] = useState<{
    requestId: string;
    threadId?: string;
  }>();
  const [fileBusy, setFileBusy] = useState(false);
  const closePanel = () => {
    if (
      fileBusy &&
      !confirm(
        '关闭面板会取消传输；正在提交的文件可能已经发布，请重新打开核对结果。继续？',
      )
    )
      return;
    setFileBusy(false);
    setPanel(null);
  };
  const [notice, setNotice] = useState('');
  const [reconnect, setReconnect] = useState(0);
  const [away, setAway] = useState(false);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<{
    requestId: string;
    text?: string;
    action: string;
  }>();
  const pendingCommand = useRef<typeof unconfirmed>(undefined);
  const draft = useRef('');
  draft.current = text;
  const online = hosts.find((h) => h.id === host)?.online === true;
  const remoteTarget = `${hosts.find((h) => h.id === host)?.name || host} / ${projects.find((p) => p.id === project)?.name || project}`;
  const projectContext = useRef({ host, project });
  useEffect(() => {
    projectContext.current = { host, project };
  }, [host, project]);
  const socket = useRef<WebSocket | null>(null),
    after = useRef(0);
  const report = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  const captureHistoryAnchor = () => {
    const anchor =
      messageList.current?.querySelector<HTMLElement>('[data-event-seq]');
    historyAnchor.current = anchor?.dataset.eventSeq
      ? {
          seq: anchor.dataset.eventSeq,
          top: anchor.getBoundingClientRect().top,
        }
      : null;
  };
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
      if (retryable(results[0].reason)) {
        setChecking(false);
        return;
      }
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
      setMode('admin');
      setManaging(request);
      history.replaceState(null, '', location.pathname + location.search);
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => clearInterval(timer);
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
          if (currentMode.current === 'cw') {
            setPanel(null);
            setView('chat');
          }
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
    catalog.current?.close();
    catalog.current = null;
    void (async () => {
      try {
        const { identity } = await api(
          `/client/identity?hostId=${encodeURIComponent(host)}`,
        );
        if (disposed) return;
        const cache = new HistoryCache(
          JSON.stringify([location.origin, identity, host]),
        );
        const stored = await cache.record('catalog').catch(() => undefined);
        if (disposed) return;
        if (stored) {
          setProjects(stored.projects);
          setProject(stored.projects[0]?.id || '');
          setSessions(stored.sessions);
        }
        catalog.current = cache;
        const operation = await cache
          .record(`create:${stored?.projects[0]?.id || ''}`)
          .catch(() => undefined);
        if (!disposed && operation) setCreateOperation(operation);
        const [p, result] = await Promise.all([
          api(`/hosts/${host}/projects`),
          api('/sessions?paged=true&hostId=' + host),
        ]);
        if (disposed) return;
        setProjects(p);
        setProject(p[0]?.id || '');
        setSessions(result.data);
        setSessionCursor(result.nextCursor);
      } catch (e) {
        if (!disposed) report(e);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [host]);
  useEffect(() => {
    if (projects.length && catalog.current)
      void catalog.current
        .record('catalog', { projects, sessions })
        .catch(() => {});
  }, [projects, sessions]);
  useEffect(() => {
    let disposed = false;
    setCreateOperation(undefined);
    void catalog.current
      ?.record(`create:${project}`)
      .then((operation) => {
        if (!disposed) setCreateOperation(operation || undefined);
      })
      .catch(report);
    return () => {
      disposed = true;
    };
  }, [host, project]);
  useEffect(() => {
    if (!createOperation || !host || !project) return;
    let disposed = false;
    const controller = new AbortController();
    const query = async () => {
      try {
        const result = await api(
          `/hosts/${host}/requests/${createOperation.requestId}`,
          undefined,
          controller.signal,
        );
        if (disposed) return;
        if (result.state === 'completed') {
          const session = result.result as Session;
          setSessions((sessions) => [
            session,
            ...sessions.filter((s) => s.id !== session.id),
          ]);
          setSelected(session);
          setTakeover(false);
          setPanel(null);
          setCreateOperation(undefined);
          void catalog.current?.record(`create:${project}`, null);
        } else if (result.state === 'failed') {
          setError(result.result.requestError.message);
          setCreateOperation(undefined);
          void catalog.current?.record(`create:${project}`, null);
        }
      } catch {
        /* Read-only status polling can wait for reconnection. */
      }
    };
    void query();
    const timer = setInterval(() => void query(), 5000);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [host, project, createOperation?.requestId]);
  async function loadThreads(append = false) {
    if (!host || !project || !online) return;
    const request = ++historyRequest.current;
    setLoadingThreads(true);
    setThreadError('');
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
      if (request === historyRequest.current) {
        setThreadError(e instanceof Error ? e.message : String(e));
        report(e);
      }
    } finally {
      if (request === historyRequest.current) setLoadingThreads(false);
    }
  }
  useEffect(() => {
    setThreads([]);
    setThreadError('');
    setCursor(null);
    setSearch('');
    void loadThreads();
    return () => {
      historyRequest.current++;
    };
  }, [host, project, online]);
  useEffect(() => {
    if (followMessages.current && messageList.current)
      messageList.current.scrollTop = messageList.current.scrollHeight;
  }, [events, view]);
  useLayoutEffect(() => {
    const anchor = historyAnchor.current;
    historyAnchor.current = null;
    const list = messageList.current;
    if (!anchor || !list) return;
    const restored = list?.querySelector<HTMLElement>(
      `[data-event-seq="${anchor.seq}"]`,
    );
    if (restored) {
      list.scrollTop += restored.getBoundingClientRect().top - anchor.top;
      messageScrollTop.current = list.scrollTop;
    }
  }, [events, loadingHistory]);
  useEffect(() => {
    const visible = new Set(events.map((event) => String(event.seq)));
    setContentChunks((chunks) =>
      Object.keys(chunks).some((seq) => !visible.has(seq))
        ? Object.fromEntries(
            Object.entries(chunks).filter(([seq]) => visible.has(seq)),
          )
        : chunks,
    );
  }, [events]);
  useEffect(() => {
    setReady(false);
    setEvents([]);
    setHasOlder(false);
    setLoadingHistory(false);
    setHistoryNotice('');
    messageScrollTop.current = 0;
    historyAnchor.current = null;
    setContentChunks({});
    setReadingContent({});
    olderView.current = false;
    setApprovals([]);
    setText('');
    setUnconfirmed(undefined);
    pendingCommand.current = undefined;
    followMessages.current = true;
    if (!selected) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>,
      handshake: ReturnType<typeof setTimeout>,
      attempt = 0;
    after.current = 0;
    setEvents([]);
    setApprovals([]);
    setReady(false);
    setPending(false);
    setBusy(selected.state === 'ready' && selected.running);
    const seen = new Map<number, number>();
    let stateSeq = 0;
    const add = (e: Event, live = true) => {
      const revision = e.revision ?? e.seq;
      if ((seen.get(e.seq) ?? -1) >= revision) return;
      seen.set(e.seq, revision);
      if (seen.size > 2000) seen.delete(seen.keys().next().value!);
      after.current = Math.max(after.current, e.seq);
      if (!olderView.current)
        setEvents((v) => {
          const merged = eventWindow([...v, e]);
          if (v.length && merged[0]?.seq > v[0].seq) setHasOlder(true);
          setOlderCursor(merged[0]?.seq ?? 0);
          return merged;
        });
      if (!live) return;
      const d = e.data as any;
      if (e.type === 'sessionClosed') {
        setReady(false);
        setStatus('会话已结束');
        setSelected((current) =>
          current?.id === selected.id
            ? { ...current, state: d.state, running: false }
            : current,
        );
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
    const controller = new AbortController();
    let terminal = false;
    const retry = () => {
      if (disposed || terminal) return;
      clearTimeout(timer);
      timer = setTimeout(
        () => void connect(),
        Math.min(15000, 1000 * 2 ** Math.min(attempt++, 5)) *
          (0.8 + Math.random() * 0.4),
      );
    };
    const checkPending = async () => {
      const command = pendingCommand.current;
      if (!command) return;
      try {
        const result = await api(
          `/hosts/${host}/requests/${command.requestId}?sessionId=${encodeURIComponent(selected.id)}`,
          undefined,
          controller.signal,
        );
        if (disposed) return;
        if (result.state === 'completed' || result.state === 'failed') {
          pendingCommand.current = undefined;
          setUnconfirmed(undefined);
          setPending(false);
          void cache?.record('pending', null);
          if (result.state === 'failed') {
            setText((text) => text || command.text || '');
            setError(result.result.requestError.message);
          }
        } else {
          setPending(false);
          setUnconfirmed(command);
          setNotice('提交结果尚未确认，请核对远程历史；不要重复提交同一任务。');
        }
      } catch (e) {
        if (!disposed) report(e);
      }
    };
    const connect = async () => {
      setStatus(attempt ? '正在重连' : '正在连接');
      setReady(false);
      try {
        const t = await api(
          `/sessions/${selected.id}/${takeover ? 'takeover' : 'attach'}`,
          {},
          controller.signal,
        );
        if (disposed) return;
        const ws = new WebSocket(
          location.origin.replace(/^http/, 'ws') + '/ws/v1/web/' + selected.id,
        );
        socket.current = ws;
        handshake = setTimeout(() => ws.close(), 15000);
        ws.onopen = () => {
          if (!disposed)
            ws.send(JSON.stringify({ type: 'auth', ticket: t.ticket }));
        };
        ws.onmessage = (message) => {
          if (disposed) return;
          try {
            const d = JSON.parse(message.data);
            if (d.receiptId)
              ws.send(
                JSON.stringify({ type: 'receipt', receiptId: d.receiptId }),
              );
            if (d.type === 'attached') {
              ws.send(
                JSON.stringify({
                  action: 'sync',
                  after: Number.MAX_SAFE_INTEGER,
                }),
              );
              return;
            }
            if (d.type === 'sync') {
              clearTimeout(handshake);
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
                void checkPending();
              }
              return;
            }
            if (d.type === 'event') add(d.event);
            if (d.type === 'ack') {
              if (pendingCommand.current?.requestId === d.requestId) {
                pendingCommand.current = undefined;
                setUnconfirmed(undefined);
                void cache?.record('pending', null);
              }
              setPending(false);
            }
            if (d.type === 'error') {
              setPending(false);
              if (
                d.requestId === pendingCommand.current?.requestId &&
                d.error.code !== 'RESULT_UNKNOWN'
              ) {
                const command = pendingCommand.current;
                setText((text) => text || command?.text || '');
                pendingCommand.current = undefined;
                setUnconfirmed(undefined);
                void cache?.record('pending', null);
              }
              if (
                [
                  'SESSION_BUSY',
                  'STALE_CONTROLLER',
                  'UNAUTHORIZED',
                  'FORBIDDEN',
                  'SESSION_CLOSED',
                ].includes(d.error.code)
              )
                terminal = true;
              setError(d.error.code + ': ' + d.error.message);
            }
          } catch (e) {
            report(e);
          }
        };
        ws.onclose = (e) => {
          clearTimeout(handshake);
          if (disposed) return;
          setReady(false);
          setPending(false);
          setStatus('已断开');
          if (e.code === 4009) {
            terminal = true;
            setStatus('只读观察 · 其他设备控制');
            setError('控制权已被其他设备接管');
            return;
          }
          if (e.code === 4001) {
            terminal = true;
            setError('登录已过期或被撤销，请重新登录');
            return;
          }
          retry();
        };
        ws.onerror = () => {
          if (!disposed) setStatus('连接错误');
        };
      } catch (e) {
        if (!disposed) {
          report(e);
          setStatus(
            retryable(e)
              ? '连接中断，正在等待恢复；远程任务可能仍在执行'
              : '只读观察 · 无法取得控制权',
          );
          if (retryable(e)) retry();
          else terminal = true;
        }
      }
    };
    let historyTimer: ReturnType<typeof setTimeout>;
    let cache: HistoryCache | undefined;
    let checkpoint: number | undefined;
    const requests = new Map<string, number | 'sync'>();
    let pageLoading = false;
    let pageTimer: ReturnType<typeof setTimeout>;
    let pageGeneration = 0;
    const finishPage = () => {
      pageLoading = false;
      clearTimeout(pageTimer);
      if (!disposed) setLoadingHistory(false);
    };
    const contentReads = new Map<
      number,
      { requestId: string; timer: ReturnType<typeof setTimeout> }
    >();
    const finishRead = (seq: number) => {
      clearTimeout(contentReads.get(seq)?.timer);
      contentReads.delete(seq);
      if (!disposed) setReadingContent((state) => ({ ...state, [seq]: false }));
    };
    const cacheError = () => {
      if (!disposed) setError('本地历史缓存不可用；仍可从 Agent 读取历史。');
    };
    const showPage = (page: HistoryPage) => {
      if (olderView.current) captureHistoryAnchor();
      setEvents((previous) => {
        const merged = mergeEvents([...page.events, ...previous]);
        return olderView.current ? merged : eventWindow(merged);
      });
      setOlderCursor(page.events[0]?.seq ?? 0);
      setHasOlder(page.more);
      finishPage();
    };
    const requestPage = (before = 0) => {
      if (pageLoading || disposed) return;
      pageLoading = true;
      const generation = ++pageGeneration;
      if (before) captureHistoryAnchor();
      olderView.current = before !== 0;
      followMessages.current = before === 0;
      setLoadingHistory(true);
      setHistoryNotice('');
      pageTimer = setTimeout(() => {
        pageGeneration++;
        for (const [id, request] of requests)
          if (typeof request === 'number') requests.delete(id);
        finishPage();
        if (!disposed) setError('历史读取超时，可重试加载更早内容。');
      }, 15000);
      void (async () => {
        if (before && cache) {
          const stored = await cache.page(before).catch(() => undefined);
          if (disposed || generation !== pageGeneration) return;
          if (stored) {
            showPage(stored);
            return;
          }
        }
        const hs = historySocket.current;
        if (hs?.readyState !== WebSocket.OPEN) {
          finishPage();
          setHistoryNotice('较早内容尚未缓存，连接恢复后可重试。');
          return;
        }
        const requestId = crypto.randomUUID();
        requests.set(requestId, before);
        hs.send(JSON.stringify({ operation: 'page', before, requestId }));
      })();
    };
    loadHistory.current = requestPage;
    loadContent.current = (seq, offset, revision) => {
      if (contentReads.has(seq)) return;
      const requestId = crypto.randomUUID();
      contentReads.set(seq, {
        requestId,
        timer: setTimeout(() => {
          finishRead(seq);
          if (!disposed)
            setError('内容读取超时，可重试；远程任务不会因此重新执行。');
        }, 15000),
      });
      setReadingContent((state) => ({ ...state, [seq]: true }));
      void (async () => {
        const stored = await cache
          ?.content(seq, offset, revision)
          .catch(() => undefined);
        if (disposed || contentReads.get(seq)?.requestId !== requestId) return;
        if (stored) {
          finishRead(seq);
          setContentChunks((v) => ({
            ...v,
            [seq]: {
              ...stored,
              truncated:
                !!offset &&
                (!!v[seq]?.truncated ||
                  (v[seq]?.text.length || 0) + stored.text.length > 131072),
              text:
                offset && v[seq]?.revision === revision
                  ? (v[seq].text + stored.text).slice(-131072)
                  : stored.text,
            },
          }));
          return;
        }
        if (historySocket.current?.readyState !== WebSocket.OPEN) {
          finishRead(seq);
          setNotice('此部分未缓存，服务器连接恢复后可读取。');
          return;
        }
        historySocket.current.send(
          JSON.stringify({
            operation: 'content',
            seq,
            offset,
            revision,
            requestId,
          }),
        );
      })();
    };
    const connectHistory = async () => {
      try {
        const { identity } = await api(
          `/client/identity?hostId=${encodeURIComponent(host)}`,
        );
        if (disposed) return;
        if (!cache) {
          cache = new HistoryCache(
            JSON.stringify([location.origin, identity, host, selected.id]),
          );
          localHistory.current = cache;
          const savedDraft = await cache.record('draft').catch(() => undefined);
          const savedPending = await cache
            .record('pending')
            .catch(() => undefined);
          if (disposed) return;
          setText(savedDraft || '');
          if (savedPending) {
            pendingCommand.current = savedPending;
            setUnconfirmed(savedPending);
            void checkPending();
          }
          const stored = await cache.latest().catch(() => {
            cacheError();
            return undefined;
          });
          if (disposed) return;
          if (stored) {
            checkpoint = stored.checkpoint;
            setEvents((v) => eventWindow([...stored.events, ...v]));
            setOlderCursor(stored.events[0]?.seq ?? 0);
            setHasOlder(stored.events.length > 0);
          }
        }
        const hs = new WebSocket(
          location.origin.replace(/^http/, 'ws') +
            '/ws/v1/history/' +
            selected.id,
        );
        historySocket.current = hs;
        const sync = () => {
          const requestId = crypto.randomUUID();
          requests.set(requestId, 'sync');
          hs.send(
            JSON.stringify({
              operation: 'page',
              requestId,
              ...(checkpoint === undefined ? {} : { after: checkpoint }),
            }),
          );
        };
        hs.onmessage = (message) => {
          if (disposed) return;
          try {
            const d = JSON.parse(message.data);
            if (d.receiptId)
              hs.send(
                JSON.stringify({ type: 'receipt', receiptId: d.receiptId }),
              );
            if (d.type === 'history-ready') {
              sync();
              return;
            }
            if (d.type === 'event') {
              add(d.event);
              void cache?.write([d.event]).catch(cacheError);
              return;
            }
            if (d.type === 'error') {
              if (
                !d.requestId ||
                typeof requests.get(d.requestId) === 'number'
              ) {
                requests.delete(d.requestId);
                finishPage();
              }
              for (const [seq, read] of contentReads) {
                if (!d.requestId || read.requestId === d.requestId) {
                  finishRead(seq);
                  if (d.error.code === 'CONTENT_CHANGED') {
                    setContentChunks((chunks) => {
                      const next = { ...chunks };
                      delete next[seq];
                      return next;
                    });
                    sync();
                  }
                }
              }
              setError(d.error.message);
              return;
            }
            if (d.type !== 'history') return;
            if (d.text !== undefined) {
              if (contentReads.get(d.seq)?.requestId !== d.requestId) return;
              finishRead(d.seq);
              void cache
                ?.content(d.seq, d.offset, d.revision, d)
                .catch(cacheError);
              setContentChunks((v) => ({
                ...v,
                [d.seq]: {
                  truncated:
                    !!d.offset &&
                    (!!v[d.seq]?.truncated ||
                      (v[d.seq]?.text.length || 0) + d.text.length > 131072),
                  text:
                    d.offset && v[d.seq]?.revision === d.revision
                      ? (v[d.seq].text + d.text).slice(-131072)
                      : d.text,
                  revision: d.revision,
                  nextOffset: d.nextOffset,
                  more: d.more,
                },
              }));
              return;
            }
            const request = requests.get(d.requestId);
            requests.delete(d.requestId);
            if (request === 'sync') {
              // Advance only from the replay response, never from interleaved live events.
              checkpoint = d.direction === 'before' ? d.snapshotSeq : d.cursor;
              for (const e of d.events) add(e, false);
              void cache?.write(d.events, checkpoint).catch(cacheError);
              if (d.direction === 'before') {
                if (!olderView.current) {
                  setOlderCursor(d.events[0]?.seq ?? 0);
                  setHasOlder(d.more);
                }
              }
              if (d.direction === 'after' && d.more) sync();
            } else if (typeof request === 'number') {
              showPage(d);
              void cache
                ?.write(d.events, undefined, request, d)
                .catch(cacheError);
            }
          } catch (e) {
            report(e);
          }
        };
        hs.onclose = () => {
          for (const seq of contentReads.keys()) finishRead(seq);
          requests.clear();
          pageGeneration++;
          finishPage();
          if (!disposed)
            historyTimer = setTimeout(() => void connectHistory(), 3000);
        };
      } catch (e) {
        if (!disposed) {
          report(e);
          if (retryable(e))
            historyTimer = setTimeout(() => void connectHistory(), 5000);
        }
      }
    };
    void connectHistory();
    if (selected.state === 'ready') void connect();
    else setStatus('查看已结束会话的历史');
    return () => {
      disposed = true;
      controller.abort();
      void cache
        ?.record('draft', draft.current)
        .catch(() => {})
        .finally(() => cache?.close());
      clearTimeout(historyTimer);
      clearTimeout(pageTimer);
      historySocket.current?.close();
      historySocket.current = null;
      localHistory.current = null;
      requests.clear();
      for (const seq of contentReads.keys()) finishRead(seq);
      disposed = true;
      clearTimeout(timer);
      clearTimeout(handshake);
      socket.current?.close();
      socket.current = null;
    };
  }, [selected?.id, takeover, host, reconnect]);
  const send = (data: {
    action: string;
    text?: string;
    [key: string]: unknown;
  }) => {
    if (socket.current?.readyState !== WebSocket.OPEN || !ready || !online)
      return;
    if (data.action === 'prompt' && pendingCommand.current) return;
    const command = { ...data, requestId: crypto.randomUUID() };
    const targetSocket = socket.current;
    const targetCache = localHistory.current;
    if (data.action === 'prompt') {
      pendingCommand.current = command;
      setUnconfirmed(command);
      // Persist the identity before the send. Cache failure leaves the draft intact.
      void (async () => {
        let submitted = false;
        try {
          if (!targetCache) throw new Error('本机存储尚未就绪');
          await targetCache.record('pending', command);
          if (
            socket.current !== targetSocket ||
            targetSocket.readyState !== WebSocket.OPEN
          )
            throw new Error('连接或会话已切换，任务尚未发送');
          setPending(true);
          submitted = true;
          targetSocket.send(JSON.stringify(command));
          setText((current) => (current === data.text ? '' : current));
          if (draft.current === data.text) void targetCache.record('draft', '');
        } catch (e) {
          if (!submitted) {
            void targetCache?.record('pending', null).catch(() => {});
            if (pendingCommand.current?.requestId === command.requestId) {
              pendingCommand.current = undefined;
              setUnconfirmed(undefined);
            }
          }
          if (socket.current === targetSocket) {
            report(e);
            setPending(false);
          }
        }
      })();
    } else {
      setPending(true);
      socket.current.send(JSON.stringify(command));
    }
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
        if (currentMode.current === 'admin') {
          setPanel(null);
          setView('devices');
        }
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
  useEffect(() => {
    if (managing && view === 'devices')
      document
        .getElementById(`request-${managing}`)
        ?.scrollIntoView({ block: 'nearest' });
  }, [managing, view, devices.pending.length]);
  async function manage(action: 'approve' | 'reject' | 'revoke', id: string) {
    const device = devices.credentials.find((item) => item.id === id);
    if (
      action === 'revoke' &&
      !confirm(
        device?.role === 'agent'
          ? `停用服务器 ${device.name} 并撤销其所有客户端授权？相关连接会关闭。`
          : `撤销客户端 ${device?.name || id} 的访问？该客户端连接会关闭，其他授权保留。`,
      )
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
    if (creating || !online) return;
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
      setPanel(null);
      return;
    }
    setCreating(true);
    try {
      setError('');
      const cache = catalog.current;
      if (!cache) throw new Error('本机存储尚未就绪，请稍后重试');
      const previous = await cache.record(`create:${project}`);
      if (previous && previous.threadId !== threadId)
        throw new Error('当前项目有待确认的会话创建请求，请先查询结果。');
      const operation = previous || {
        requestId: crypto.randomUUID(),
        ...(threadId ? { threadId } : {}),
      };
      await cache.record(`create:${project}`, operation);
      setCreateOperation(operation);
      const s = await api(
        '/sessions',
        {
          hostId: host,
          projectId: project,
          mode: 'web',
          ...(threadId ? { threadId } : {}),
        },
        undefined,
        operation.requestId,
      );
      await cache.record(`create:${project}`, null);
      setCreateOperation(undefined);
      if (
        projectContext.current.host !== host ||
        projectContext.current.project !== project
      )
        return;
      setSessions((v) => [s, ...v]);
      setTakeover(false);
      setSelected(s);
      setPanel(null);
      void loadThreads();
    } catch (e) {
      if (
        e instanceof ApiError &&
        e.status < 500 &&
        e.code !== 'RESULT_UNKNOWN' &&
        e.code !== 'IDEMPOTENCY_CONFLICT'
      ) {
        void catalog.current?.record(`create:${project}`, null);
        setCreateOperation(undefined);
      }
      report(e);
    } finally {
      setCreating(false);
    }
  }
  const openSessions = () => {
    setView('chat');
    setPanel('sessions');
    setMenuOpen(false);
  };
  const switchMode = () => {
    const next = mode === 'cw' ? 'admin' : 'cw';
    setMode(next);
    setView(next === 'admin' ? 'devices' : 'chat');
    setPanel(null);
    setSecret('');
    setNewKey('');
    setError('');
  };
  const connectionControls = logged && (
    <section className="card">
      <h2>登录与授权</h2>
      <button onClick={() => setAdding((v) => !v)}>添加 A 授权</button>
    </section>
  );
  const loginForm = !checking && (adminLogin ? !admin : !logged || adding) && (
    <form onSubmit={login} className="card login-card">
      <h2>{adminLogin ? '管理员登录' : '连接远程服务器'}</h2>
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
            服务器标识
            <input
              aria-label="服务器标识"
              required
              value={targetHost}
              onChange={(e) => setTargetHost(e.target.value)}
            />
          </label>
          <small>
            服务器标识可从服务器登录结果或管理员处获取。设备名称供管理员识别这台浏览器。
          </small>
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
      <button type="submit" disabled={generating || (!adminLogin && !!grant)}>
        {adminLogin ? '登录' : '申请登录'}
      </button>
      {!adminLogin && grant && (
        <div role="status">
          <p>
            等待管理员批准，配对码：<strong>{grant.code}</strong>
          </p>
          <p>
            服务器：{targetHost} · 设备：{deviceName}
          </p>
          <details>
            <summary>请求标识</summary>
            <p>{grant.id}</p>
          </details>
          <p>有效期至 {new Date(grant.expires).toLocaleString()}</p>
        </div>
      )}
      {!adminLogin && (
        <p>
          填写服务器 → 提交申请 →
          管理员核对配对码并批准。每份网页凭证访问一台服务器，长期有效，直到管理员撤销。
        </p>
      )}
    </form>
  );
  const projectPicker = (
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
              <option key={h.id} value={h.id}>
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
          disabled={!online || !host || !project || creating}
          onClick={() => {
            setView('chat');
            void create();
          }}
        >
          创建网页会话
        </button>
      </div>
    </section>
  );
  return (
    <main className={view === 'chat' && logged ? 'chat-workspace' : undefined}>
      <header className="topbar" ref={menu}>
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            setView(mode === 'admin' ? 'devices' : 'chat');
            setMenuOpen(false);
          }}
        >
          {view === 'chat' && logged ? (
            <span>
              {threads.find((t) => t.id === selected?.threadId)?.name ||
                'Codex 对话'}
            </span>
          ) : (
            <>
              <CodexMark /> <span>远程 Codex</span>
              <small>{mode === 'admin' ? '管理员模式' : 'CW 工作台'}</small>
            </>
          )}
        </a>
        {logged && view === 'chat' && (
          <div className="header-actions">
            <button onClick={() => setPanel('sessions')}>历史</button>
            <button
              disabled={!online || !project || creating}
              onClick={() => void create()}
            >
              新建
            </button>
          </div>
        )}
        <button
          className="menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="feature-menu"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MenuIcon /> 功能菜单
        </button>
        {menuOpen && (
          <nav id="feature-menu" aria-label="功能菜单">
            <div className="menu-heading">
              <strong>{mode === 'cw' ? 'CW 模式' : '管理员模式'}</strong>
              <small>
                {mode === 'cw'
                  ? '对话与远程工作区'
                  : admin
                    ? '已登录管理'
                    : '需要管理员登录'}
              </small>
            </div>
            <div className="menu-items">
              {mode === 'cw' && logged && (
                <>
                  <button
                    onClick={() => {
                      setView('chat');
                      setPanel('sessions');
                      setMenuOpen(false);
                    }}
                  >
                    <strong>会话记录</strong>
                    <small>恢复与搜索历史对话</small>
                  </button>
                  <button
                    disabled={creating || !online}
                    onClick={() => {
                      setMenuOpen(false);
                      setPanel(null);
                      if (host && project) {
                        setView('chat');
                        void create();
                      } else openSessions();
                    }}
                  >
                    <strong>新建对话</strong>
                    <small>在当前项目开始新对话</small>
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      if (host && project) {
                        setView('chat');
                        setPanel('files');
                      } else {
                        setPanel(null);
                        openSessions();
                      }
                    }}
                  >
                    <strong>工作区文件</strong>
                    <small>上传、下载远程项目文件</small>
                  </button>
                  <button
                    disabled={!selected}
                    onClick={() => {
                      setView('chat');
                      setPanel('details');
                      setMenuOpen(false);
                    }}
                  >
                    <strong>会话详情</strong>
                    <small>连接状态、远程项目与会话操作</small>
                  </button>
                </>
              )}
              {(mode === 'cw'
                ? ([
                    ['chat', 'CW 对话', '会话与远程任务'],
                    ...(!logged
                      ? ([
                          ['connection', '登录与授权', '连接远程服务器'],
                        ] as const)
                      : []),
                  ] as const)
                : ([
                    ['devices', '设备授权', '审批与管理设备'],
                    ['keys', 'API Key', '管理访问凭证'],
                  ] as const)
              ).map(([id, label, description]) => (
                <button
                  key={id}
                  aria-current={view === id ? 'page' : undefined}
                  onClick={() => {
                    setView(id);
                    setPanel(null);
                    setMenuOpen(false);
                  }}
                >
                  <strong>{label}</strong>
                  <small>{description}</small>
                </button>
              ))}
              {mode === 'admin' && admin && (
                <button
                  onClick={() =>
                    void api('/auth/logout', {})
                      .then(() => {
                        setAdmin(false);
                        setNewKey('');
                        setSecret('');
                        setMenuOpen(false);
                      })
                      .catch(report)
                  }
                >
                  <strong>退出管理</strong>
                  <small>结束当前管理员登录</small>
                </button>
              )}
            </div>
            <div className="menu-footer">
              <button className="mode-switch" onClick={switchMode}>
                <span aria-hidden="true">⇄</span>
                切换到{mode === 'cw' ? '管理员' : 'CW'}模式
              </button>
            </div>
          </nav>
        )}
      </header>
      {logged && view === 'chat' && (
        <WorkspaceHeader
          host={hosts.find((h) => h.id === host)?.name || host}
          project={projects.find((p) => p.id === project)?.name || project}
          status={
            !online
              ? '服务器离线 · 只读缓存'
              : approvals.length
                ? '等待你的确认'
                : status
          }
          onDetails={() => {
            if (selected) setPanel('details');
            else openSessions();
          }}
        />
      )}
      {createOperation && (
        <div className="notice" role="status">
          正在确认 {remoteTarget} 的会话创建结果。请求：
          {createOperation.requestId}
          <button
            disabled={creating || !online}
            onClick={() => void create(createOperation.threadId)}
          >
            以原请求继续确认
          </button>
          <small>重复使用同一请求身份；不会自动另建任务。</small>
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          {notice}
          <button onClick={() => setNotice('')}>关闭</button>
        </div>
      )}
      {view !== 'chat' && (
        <div className="page-heading">
          <span>
            {
              {
                chat: 'CW 对话',
                connection: '登录与授权',
                devices: '设备授权',
                keys: 'API Key 管理',
              }[view]
            }
          </span>
          <small>
            {mode === 'admin'
              ? '管理员模式'
              : hosts.find((h) => h.id === host)?.name ||
                '选择远程主机开始工作'}
          </small>
        </div>
      )}
      {error && (
        <div role="alert" className="error">
          {error}
          <button onClick={() => setError('')}>关闭</button>
        </div>
      )}
      {checking && <p role="status">正在检查登录状态…</p>}
      {(view !== 'chat' || !logged) && loginForm}
      {admin && view === 'devices' && (
        <section className="card">
          <h2>设备授权管理</h2>
          <button
            onClick={() => {
              if (confirm('撤销其他浏览器的管理员登录？设备与客户端授权保留。'))
                void api('/auth/logout-others', {})
                  .then(() => setNotice('其他管理会话已撤销'))
                  .catch(report);
            }}
          >
            退出其他管理会话
          </button>
          <p>
            批准前请与申请方核对配对码、角色和目标 A。管理身份不能直接操作 Codex
            会话。
          </p>
          {managing && <p>当前请求：{managing}</p>}
          <h3>待授权请求</h3>
          {!devices.pending.length && <p>暂无待授权请求</p>}
          {devices.pending.map((d) => (
            <div
              className={`card ${d.id === managing ? 'highlight-request' : ''}`}
              id={`request-${d.id}`}
              key={d.id}
            >
              <p>
                {d.name} ·{' '}
                {d.role === 'agent'
                  ? '服务器 Agent'
                  : d.role === 'cli'
                    ? '命令行客户端'
                    : '网页客户端'}{' '}
                · 配对码 {d.code}
              </p>
              <p>
                目标服务器：
                {keyHosts.find((host) => host.id === d.hostId)?.name ||
                  d.hostId}
              </p>
              <details>
                <summary>请求标识与有效期</summary>
                <p>
                  {d.id} · 有效期至 {new Date(d.expires).toLocaleString()}
                </p>
              </details>
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
            <div className="card" key={d.id} data-credential-id={d.id}>
              <p>
                {d.name} ·{' '}
                {d.role === 'agent'
                  ? '服务器 Agent'
                  : d.role === 'cli'
                    ? '命令行客户端'
                    : '网页客户端'}{' '}
                · 服务器：
                {keyHosts.find((host) => host.id === d.hostId)?.name ||
                  d.hostId}
              </p>
              <p>授权时间：{new Date(d.created).toLocaleString()} · 长期有效</p>
              <details>
                <summary>授权标识与服务器</summary>
                <p className="id">
                  {d.id} · {d.hostId}
                </p>
                <CopyText text={d.id} />
              </details>
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
                  void navigator.clipboard
                    .writeText(newKey)
                    .then(() => setNotice('已复制'))
                    .catch(() =>
                      setNotice('剪贴板不可用，请选择上方文本手动复制'),
                    )
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
                服务器：
                {keyHosts.find((host) => host.id === k.hostId)?.name ||
                  k.hostId ||
                  '等待首次使用绑定'}
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
      {logged && view === 'chat' && (
        <>
          {view === 'chat' && (
            <div className="chat-layout">
              <dialog
                className="chat-panel"
                ref={panelDialog}
                aria-labelledby="chat-panel-title"
                onClose={() => {
                  setPanel(null);
                  menu.current
                    ?.querySelector<HTMLButtonElement>('.menu-toggle')
                    ?.focus();
                }}
                onCancel={(event) => {
                  event.preventDefault();
                  closePanel();
                }}
                onClick={(e) => {
                  const bounds = e.currentTarget.getBoundingClientRect();
                  if (
                    e.target === e.currentTarget &&
                    (e.clientX < bounds.left ||
                      e.clientX > bounds.right ||
                      e.clientY < bounds.top ||
                      e.clientY > bounds.bottom)
                  )
                    closePanel();
                }}
              >
                <div className="panel-heading">
                  <h2 id="chat-panel-title">
                    {panel === 'details'
                      ? '会话详情'
                      : panel === 'files'
                        ? '工作区文件'
                        : '会话记录'}
                  </h2>
                  <button aria-label="关闭面板" onClick={closePanel}>
                    关闭
                  </button>
                </div>
                {panel === 'files' && (
                  <WorkspaceFiles
                    host={host}
                    project={project}
                    target={remoteTarget}
                    onBusy={setFileBusy}
                    cache={catalog.current}
                  />
                )}
                {panel === 'sessions' && (
                  <aside className="session-sidebar">
                    <section
                      className="connection-settings"
                      aria-label="连接设置"
                    >
                      <h3>连接设置</h3>
                      {error && (
                        <p className="error" role="alert">
                          {error}
                        </p>
                      )}
                      {projectPicker}
                      {connectionControls}
                      {loginForm}
                    </section>
                    <h3>会话列表</h3>
                    <button
                      className="new-chat"
                      disabled={!online || !host || !project || creating}
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
                        void api('/sessions?paged=true&hostId=' + host)
                          .then((page) => {
                            setSessions(page.data);
                            setSessionCursor(page.nextCursor);
                          })
                          .catch(report);
                      }}
                    >
                      {loadingThreads ? '正在加载…' : '刷新会话'}
                    </button>
                    <p className="sidebar-caption">
                      与远程 Codex 共用历史 · 当前项目
                    </p>
                    <SessionHistory
                      sessions={sessions}
                      threads={threads}
                      project={project}
                      projectName={
                        projects.find((p) => p.id === project)?.name || project
                      }
                      selected={selected}
                      search={search}
                      online={online}
                      loading={loadingThreads}
                      error={threadError}
                      creating={creating}
                      onSelect={(session) => {
                        setTakeover(false);
                        setSelected(session);
                        setPanel(null);
                      }}
                      onResume={(threadId) => void create(threadId)}
                    />
                    {sessionCursor && (
                      <button
                        disabled={!online}
                        onClick={() =>
                          void api(
                            `/sessions?paged=true&hostId=${host}&cursor=${encodeURIComponent(sessionCursor)}`,
                          )
                            .then((page) => {
                              setSessions((old) => [
                                ...old,
                                ...page.data.filter(
                                  (s: Session) =>
                                    !old.some((o) => o.id === s.id),
                                ),
                              ]);
                              setSessionCursor(page.nextCursor);
                            })
                            .catch(report)
                        }
                      >
                        加载更多会话记录
                      </button>
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
                )}
                {panel === 'details' && selected && (
                  <section className="session-details">
                    <p className="status">
                      {status} · {busy ? '执行中' : '空闲'} · 远程项目{' '}
                      {selected.projectId}
                    </p>
                    {selected.state !== 'ready' && selected.threadId && (
                      <button
                        disabled={!online || creating}
                        onClick={() => {
                          if (confirm(`在 ${remoteTarget} 恢复并继续此线程？`))
                            void create(selected.threadId);
                        }}
                      >
                        恢复并继续
                      </button>
                    )}
                    <p>{remoteTarget}</p>
                    <p>{projects.find((p) => p.id === project)?.path}</p>
                    <details>
                      <summary>会话标识</summary>
                      <p className="id">{selected.id}</p>
                    </details>
                    <details>
                      <summary>本机存储</summary>
                      <p>
                        清理仅删除本设备历史副本，保留草稿与待确认请求；远程历史保留。未重新缓存前无法离线读取。
                      </p>
                      <button
                        onClick={() => {
                          if (
                            confirm(
                              '清理此设备的会话缓存？离线时将无法读取这些副本。',
                            )
                          )
                            void localHistory.current
                              ?.clear()
                              .then(() => setNotice('本机会话缓存已清理'))
                              .catch(report);
                        }}
                      >
                        清理本机会话缓存
                      </button>
                    </details>
                    <div className="row">
                      <button
                        disabled={!ready || !online || !busy}
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
                                setPanel(null);
                                setStatus('会话已结束');
                              })
                              .catch(report);
                        }}
                      >
                        结束会话
                      </button>
                      <button
                        onClick={() => {
                          setTakeover(false);
                          setReconnect((n) => n + 1);
                        }}
                      >
                        重新连接
                      </button>
                      <button
                        onClick={() => {
                          if (
                            confirm(
                              `接管 ${remoteTarget} 的当前会话会断开其他控制端，继续？`,
                            )
                          )
                            setTakeover((v) => !v);
                        }}
                      >
                        接管控制权
                      </button>
                    </div>
                  </section>
                )}
              </dialog>
              <section className="conversation" aria-label="Codex 对话">
                {selected ? (
                  <>
                    <div
                      className="messages"
                      ref={messageList}
                      role="log"
                      aria-label="对话消息"
                      aria-live="off"
                      onScroll={(e) => {
                        const el = e.currentTarget;
                        const scrolledUp =
                          el.scrollTop < messageScrollTop.current;
                        messageScrollTop.current = el.scrollTop;
                        followMessages.current =
                          !olderView.current &&
                          el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                        setAway(!followMessages.current);
                        if (
                          scrolledUp &&
                          el.scrollTop < 160 &&
                          hasOlder &&
                          !loadingHistory
                        )
                          loadHistory.current(olderCursor);
                      }}
                    >
                      {olderView.current && (
                        <p className="status">
                          正在浏览较早内容 · 已加载的消息全部保留，可返回最新。
                        </p>
                      )}
                      <div className="row">
                        {hasOlder && (
                          <button
                            aria-label="加载更早内容"
                            disabled={loadingHistory}
                            onClick={() => loadHistory.current(olderCursor)}
                          >
                            {loadingHistory
                              ? '正在加载更早内容…'
                              : '加载更早内容'}
                          </button>
                        )}
                        {(away || olderView.current) && (
                          <button
                            disabled={loadingHistory}
                            onClick={() => {
                              olderView.current = false;
                              setAway(false);
                              loadHistory.current();
                            }}
                          >
                            返回最新内容
                          </button>
                        )}
                      </div>
                      {historyNotice && <p role="status">{historyNotice}</p>}
                      <ConversationView
                        events={events}
                        chunks={contentChunks}
                        reading={readingContent}
                        onRead={(seq, offset, revision) =>
                          loadContent.current(seq, offset, revision)
                        }
                      />
                      {busy && (
                        <p className="thinking" role="status">
                          ●{' '}
                          {approvals.length
                            ? '等待你的确认'
                            : 'Codex 正在处理…'}
                        </p>
                      )}
                      {!events.length && (
                        <p className="empty-hint">对话已就绪，发送任务开始。</p>
                      )}
                    </div>
                    <ApprovalQueue
                      approvals={approvals}
                      events={events}
                      target={`${hosts.find((h) => h.id === host)?.name || host} / ${projects.find((p) => p.id === project)?.name || project}`}
                      ready={ready && online}
                      pending={pending}
                      onAnswer={(approvalId, allow) =>
                        send({ action: 'approval', approvalId, allow })
                      }
                    />
                    {unconfirmed && (
                      <div className="submission-state" role="status">
                        <strong>
                          {pending ? '正在提交任务' : '任务提交结果待确认'}
                        </strong>
                        <p>{unconfirmed.text}</p>
                        <button
                          onClick={() => {
                            setTakeover(false);
                            setReconnect((n) => n + 1);
                          }}
                        >
                          重新连接并查询结果
                        </button>
                        <small>
                          请求 {unconfirmed.requestId}
                          ；请先核对远程历史，避免重复执行。
                        </small>
                      </div>
                    )}
                    {selected.state !== 'ready' ? (
                      <p className="readonly-hint">
                        会话已结束 · 历史只读，请从历史记录显式恢复并继续。
                      </p>
                    ) : (
                      <form
                        className="composer"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (
                            text.trim() &&
                            ready &&
                            !pending &&
                            !busy &&
                            !pendingCommand.current
                          ) {
                            send({ action: 'prompt', text });
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
                                !e.nativeEvent.isComposing &&
                                !matchMedia('(pointer: coarse)').matches
                              ) {
                                e.preventDefault();
                                e.currentTarget.form?.requestSubmit();
                              }
                            }}
                            onChange={(e) => {
                              setText(e.target.value);
                              void localHistory.current
                                ?.record('draft', e.target.value)
                                .catch(report);
                            }}
                            maxLength={64000}
                            title="Enter 发送，Shift + Enter 换行"
                            placeholder={
                              busy
                                ? '可编辑下一条草稿，任务结束后发送…'
                                : '发送消息给 Codex…'
                            }
                          />
                        </label>
                        {busy ? (
                          <button
                            type="button"
                            disabled={!ready || !online}
                            onClick={() => send({ action: 'interrupt' })}
                          >
                            停止本轮
                          </button>
                        ) : (
                          <button
                            type="submit"
                            disabled={
                              !ready ||
                              !online ||
                              pending ||
                              !!unconfirmed ||
                              !text.trim()
                            }
                          >
                            发送
                          </button>
                        )}
                        <small>
                          {matchMedia('(pointer: coarse)').matches
                            ? 'Enter 换行，点击发送提交'
                            : 'Enter 发送 · Shift+Enter 换行'}
                          {text.length > 60000
                            ? ` · 剩余 ${64000 - text.length} 字符`
                            : ''}
                        </small>
                        {!ready && <small role="status">{status}</small>}
                      </form>
                    )}
                  </>
                ) : (
                  <div className="chat-welcome">
                    <div className="welcome-icon">
                      <CodexMark />
                    </div>
                    <h2>今天要一起完成什么？</h2>
                    <p>恢复 Codex 本地会话，或在远程项目中开始新对话。</p>
                    <button
                      disabled={creating || (!!host && !online)}
                      onClick={() => {
                        if (host && project) void create();
                        else openSessions();
                      }}
                    >
                      {host && project ? '＋ 开始新对话' : '连接远程项目'}
                    </button>
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
      {view !== 'chat' && (
        <footer>文件和命令在远程服务器执行。关闭页面不会立即停止任务。</footer>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<App />);

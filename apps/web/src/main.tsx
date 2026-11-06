import { PromptQueue } from './prompt-queue.tsx';
import {
  SessionNavigation,
  SessionHeading,
} from './happier/session-navigation.tsx';
import { WorkspaceNavigation } from './happier/workspace-navigation.tsx';
import { IconButton } from './happier/icon-button.tsx';
import { Icon, type IconName } from './happier/icon.tsx';
import { businessSocket } from './channel.ts';
import { Workbench } from './workbench/workbench.tsx';
import { promptAcknowledged } from './prompt-state.ts';
import { recoveryDelay } from './recovery.ts';
import { boundedRefresh, requestErrorMessage } from './refresh.ts';
import { deliveryIdentity } from './delivery-identity.ts';
import { CommandDelivery } from './delivery.ts';
import { OperationClient } from './operations.ts';
import { setEmailAccount, ensureEmailHost, forgetEmailHost } from './api.ts';
import { observe, recoverNotifications } from './notifications.ts';
import { relaySocketPath } from './routes.ts';
import {
  t,
  localeTag,
  useLanguage,
  setLanguage,
  type Language,
} from './i18n.ts';
import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  modelIdSchema,
  controlProofSchema,
  type ControlProof,
  type Event,
  type Session,
} from '../../../packages/protocol/src/index.ts';
import './style.css';
import './happier/site.css';
import {
  SiteTheme,
  useThemePreference,
  setThemePreference,
  type ThemePreference,
} from './theme.ts';
import { eventWindow, mergeEvents } from './events.ts';
import {
  api,
  ApiError,
  retryable,
  readApi,
  authorizationFailed,
} from './api.ts';
import { ApprovalQueue, WorkspaceHeader } from './workspace.tsx';
import { ConversationView, type ContentChunk } from './conversation.tsx';
import { WorkspaceFiles } from './files.tsx';
import { FileContext } from './file-links.tsx';
import {
  lastHost,
  rememberHost,
  restoreWorkspace,
  type WorkspaceState,
} from './workspace-state.ts';
import { HistoryCache, type HistoryPage } from './history.ts';
import { HistorySync } from './history-sync.ts';
import { HistorySubscription } from './history-subscription.ts';
import { SessionHistory, type Thread } from './session-history.tsx';
import { HostWakeSettings } from './host-wake.tsx';
import { AdminTable } from './admin-table.tsx';
import {
  AuthorizedDevices,
  type DeviceCredential,
} from './authorized-devices.tsx';
import { FilePreview } from './file-preview.tsx';
import { AutoApproval } from './auto-approval.tsx';
import { AgentUpdates } from './agent-updates.tsx';
import { RemoteConfiguration } from './remote-configuration.tsx';
import { AgentVersions } from './agent-versions.tsx';
import { version as webVersion } from '../../../package.json';
import {
  ProjectManager,
  AgentAdminEmail,
  ManagerPairing,
} from './projects.tsx';
import { HostEmailSettings } from './host-emails.tsx';
import { useBottomRefresh } from './bottom-refresh.ts';
import { ModelPicker, modelPageSchema, type ModelPage } from './models.tsx';

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
import './happier/unified-shell.css';

function App() {
  const language = useLanguage();
  const theme = useThemePreference();
  const [view, setView] = useState<View>('chat');
  const [adminTab, setAdminTab] = useState<
    | 'pending'
    | 'authorized'
    | 'versions'
    | 'wake'
    | 'emails'
    | 'projects'
    | 'sessions'
    | 'misc'
  >('pending');
  const [mode, setMode] = useState<Mode>('cw');
  const adminLogin = mode === 'admin';
  const currentMode = useRef(mode);
  currentMode.current = mode;
  const [menuOpen, setMenuOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(
    () => !matchMedia('(max-width: 900px)').matches,
  );
  const manualHostSelection = useRef<string | undefined>(undefined);
  const [appearanceTarget, setAppearanceTarget] =
    useState<HTMLDivElement | null>(null);
  const [workbenchMenuTarget, setWorkbenchMenuTarget] =
    useState<HTMLDivElement | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingThreads, setLoadingThreads] = useState(false);
  const [threadError, setThreadError] = useState('');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [panel, setPanel] = useState<'details' | 'models' | null>(null);
  const panelDialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = panelDialog.current;
    if (panel === 'models' && dialog && !dialog.open) dialog.showModal();
    else if (panel !== 'models' && dialog?.open) dialog.close();
  }, [panel]);
  const historyRequest = useRef(0);
  const historySocket = useRef<WebSocket | null>(null);
  const localHistory = useRef<HistoryCache | null>(null);
  const catalog = useRef<HistoryCache | null>(null);
  const operations = useRef<OperationClient | null>(null);
  const [catalogHost, setCatalogHost] = useState('');
  const catalogScope = useRef('');
  const savedWorkspace = useRef<WorkspaceState | undefined>(undefined);
  const olderView = useRef(false);
  const loadContent = useRef<
    (seq: number, offset: number, revision: number) => void
  >(() => {});
  const loadHistory = useRef<(before?: number, force?: boolean) => void>(
    () => {},
  );
  const readContent = useCallback(
    (seq: number, offset: number, revision: number) => {
      loadContent.current(seq, offset, revision);
    },
    [],
  );
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
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [menuOpen]);
  const [emailIdentity, setEmailIdentity] = useState<{
    enabled: boolean;
    email?: string;
    accountId?: string;
    autoAdmin?: boolean;
    legacy?: { hostId: string; name: string }[];
  }>({ enabled: false });
  const welcomeSelection = useRef<
    { hostId: string; session: Session } | undefined
  >(undefined);
  const accountRef = useRef('');
  const autoAdminAttempt = useRef('');
  const [logged, setLogged] = useState(false),
    [admin, setAdmin] = useState(false),
    [deviceMessage, setDeviceMessage] = useState(''),
    [requestedHost, setRequestedHost] = useState(''),
    [approvalHosts, setApprovalHosts] = useState<Record<string, string>>({}),
    [deviceName, setDeviceName] = useState(() => t('网页客户端')),
    [adding, setAdding] = useState(false),
    [checking, setChecking] = useState(true),
    [devices, setDevices] = useState<{
      pending: any[];
      credentials: DeviceCredential[];
    }>({
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
      requestedHostId?: string;
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
  const [controlElsewhere, setControlElsewhere] = useState(false);
  const [createOperation, setCreateOperation] = useState<{
    requestId: string;
    threadId?: string;
  }>();
  const [promptProgress, setPromptProgress] = useState<
    'sending' | 'waiting' | 'replying'
  >();
  const [fileBusy, setFileBusy] = useState(false);
  const closePanel = () => setPanel(null);
  const [notice, setNotice] = useState('');
  const [closingSession, setClosingSession] = useState<string>();
  const [projectReadOnly, setProjectReadOnly] = useState(false);
  const [terminalControl, setTerminalControl] = useState<ControlProof>();
  const [reconnect, setReconnect] = useState(0);
  const [away, setAway] = useState(false);
  const [sessionCursor, setSessionCursor] = useState<string | null>(null);
  const [unconfirmed, setUnconfirmed] = useState<{
    requestId: string;
    text?: string;
    action: string;
  }>();
  const pendingCommand = useRef<typeof unconfirmed>(undefined);
  const [selectedModel, setSelectedModel] = useState('');
  const modelRequests = useRef(
    new Map<
      string,
      {
        resolve: (page: ModelPage) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const policyRequests = useRef(
    new Map<
      string,
      {
        resolve: () => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const draft = useRef('');
  draft.current = text;
  const online = hosts.find((h) => h.id === host)?.online === true;
  const wakeConfigured =
    hosts.find((h) => h.id === host)?.wakeConfigured === true;
  const remoteTarget = `${hosts.find((h) => h.id === host)?.name || host} / ${projects.find((p) => p.id === project)?.name || project}`;
  const fileProject = projects.find((p) => p.id === selected?.projectId);
  const fileContext = useMemo(
    () =>
      fileProject
        ? { host, project: fileProject.id, root: fileProject.path }
        : null,
    [host, fileProject?.id, fileProject?.path],
  );
  const projectContext = useRef({ host, project });
  useEffect(() => {
    projectContext.current = { host, project };
  }, [host, project]);
  const socket = useRef<WebSocket | null>(null),
    after = useRef(0);
  const report = (error: unknown) => {
    const message = requestErrorMessage(error);
    if (message !== undefined) setError(message);
  };
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
  const refreshPending = useRef<Promise<void> | undefined>(undefined);
  const refreshSession = useRef<
    ((signal?: AbortSignal) => Promise<void>) | undefined
  >(undefined);
  const observeSessionHeads = useRef<
    ((id: string, heads: any) => void) | undefined
  >(undefined);
  const deliverCommand = useRef<((command: any) => Promise<void>) | undefined>(
    undefined,
  );
  const recoverCatalog = useRef<(() => Promise<void>) | undefined>(undefined);
  const [refreshing, setRefreshing] = useState(false);
  const [_refreshed, setRefreshed] = useState('');
  const bottomRefresh = useBottomRefresh(
    mode === 'cw' && view === 'chat' && !!selected && online,
    async () => {
      if (olderView.current) loadHistory.current(0, true);
      await refreshView(true);
    },
    `${host}:${selected?.id ?? ''}`,
  );
  const [revision, setRevision] = useState(0);
  const snapshotPending = useRef<Promise<void> | undefined>(undefined);
  const snapshotDirty = useRef(false);
  async function refresh() {
    snapshotDirty.current = true;
    if (snapshotPending.current) return snapshotPending.current;
    snapshotPending.current = (async () => {
      try {
        while (snapshotDirty.current) {
          snapshotDirty.current = false;
          await readSnapshot();
        }
      } finally {
        snapshotPending.current = undefined;
      }
    })();
    return snapshotPending.current;
  }
  async function readSnapshot() {
    try {
      const identity: typeof emailIdentity = await api('/auth/email');
      const nextAccount = identity.accountId || '';
      if (accountRef.current && nextAccount !== accountRef.current) {
        socket.current?.close();
        welcomeSelection.current = undefined;
        setSelected(undefined);
        setText('');
        setEvents([]);
        setProjects([]);
        setSessions([]);
        setHost('');
        rememberHost('');
        setAdmin(false);
        setGrant(undefined);
      }
      accountRef.current = nextAccount;
      setEmailAccount(nextAccount);
      setEmailIdentity(identity);
      if (identity.autoAdmin && autoAdminAttempt.current !== nextAccount) {
        autoAdminAttempt.current = nextAccount;
        await api('/auth/email/admin', {});
      }
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        report(error);
        setChecking(false);
        if (authorizationFailed(error)) {
          socket.current?.close();
          setSelected(undefined);
          setHost('');
          setHosts([]);
          setLogged(false);
          setAdmin(false);
        }
        return;
      }
    }
    const results = await Promise.allSettled([api('/hosts'), api('/auth/me')]);
    if (results[0].status === 'fulfilled') {
      const available = results[0].value;
      setHosts(available);
      setLogged(available.length > 0);
      const remembered = lastHost();
      if (remembered && !available.some((h: any) => h.id === remembered))
        rememberHost('');
      setHost((current) =>
        available.some((h: any) => h.id === current)
          ? current
          : available.some((h: any) => h.id === remembered)
            ? remembered
            : '',
      );
    } else {
      report(results[0].reason);
      if (!authorizationFailed(results[0].reason)) {
        setChecking(false);
        return;
      }
      setHosts([]);
      setLogged(false);
      setSelected(undefined);
      setHost('');
    }
    if (results[1].status === 'fulfilled') setAdmin(true);
    else if (authorizationFailed(results[1].reason)) setAdmin(false);
    setChecking(false);
  }
  useEffect(() => {
    const request = new URLSearchParams(location.hash.slice(1)).get(
      'authorize',
    );
    if (request) {
      setView('devices');
      setAdminTab('pending');
      setMode('admin');
      setManaging(request);
      history.replaceState(null, '', location.pathname + location.search);
    }
    void refresh();
    const visible = () => {
      if (document.visibilityState === 'visible') {
        recoverNotifications();
        void refresh();
        void recoverCatalog.current?.().catch(report);
        setRevision((value) => value + 1);
        // Observers recover reads independently of either session socket.
        // The snapshot never acquires control or resubmits a mutation.
        void refreshSession.current?.().catch(report);
      }
    };
    window.addEventListener('online', visible);
    document.addEventListener('visibilitychange', visible);
    return () => {
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('online', visible);
    };
  }, []);
  const adminSnapshotPending = useRef<Promise<void> | undefined>(undefined);
  const adminSnapshotDirty = useRef(false);
  const readAdminSnapshot = useCallback(() => {
    adminSnapshotDirty.current = true;
    if (adminSnapshotPending.current) return adminSnapshotPending.current;
    adminSnapshotPending.current = (async () => {
      try {
        while (adminSnapshotDirty.current) {
          adminSnapshotDirty.current = false;
          const [d, keys, available] = await Promise.all([
            api('/admin/devices'),
            api('/admin/api-keys'),
            api('/admin/hosts'),
          ]);
          if (adminSnapshotDirty.current) continue;
          setDevices(d);
          setApiKeys(keys);
          setKeyHosts(available.filter((h: any) => !h.disabled));
        }
      } finally {
        adminSnapshotPending.current = undefined;
      }
    })();
    return adminSnapshotPending.current;
  }, []);
  useEffect(() => {
    if (!admin || mode !== 'admin') return;
    let disposed = false,
      running = false,
      dirty = false;
    const update = () => {
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      dirty = false;
      void readAdminSnapshot()
        .catch(report)
        .finally(() => {
          running = false;
          if (dirty && !disposed) update();
        });
    };
    const stop = observe('/ws/v1/admin', (event) => {
      if (event.type === 'subscribed' || event.type === 'change') update();
    });
    return () => {
      disposed = true;
      stop();
    };
  }, [admin, mode, revision, readAdminSnapshot]);
  useEffect(() => {
    if (!logged) return;
    let disposed = false;
    const stops: (() => void)[] = [];
    const observedHosts = emailIdentity.enabled
      ? hosts.filter((h) => h.id === host)
      : hosts;
    for (const h of observedHosts)
      void ensureEmailHost(h.id)
        .then(() => {
          if (disposed) return;
          stops.push(
            observe(`/ws/v1/hosts/${h.id}`, (event) => {
              if (event.type === 'disconnected' && emailIdentity.enabled)
                void refresh();
              if (
                event.type === 'subscribed' ||
                (event.type === 'change' &&
                  [
                    'host',
                    'registry',
                    'requests',
                    'sessions',
                    'projects',
                  ].includes(event.scope))
              ) {
                void refresh();
                if (event.scope === 'sessions' || event.type === 'subscribed')
                  setRevision((value) => value + 1);
              }
            }),
          );
        })
        .catch(report);
    return () => {
      disposed = true;
      stops.forEach((stop) => stop());
    };
  }, [logged, hosts.map((h) => h.id).join(','), host, emailIdentity.accountId]);
  useEffect(() => {
    if (mode !== 'cw' || !host || online || !wakeConfigured) return;
    const controller = new AbortController();
    void api(`/hosts/${host}/wake`, {}, controller.signal)
      .then((result) => {
        if (result.state !== 'unconfigured')
          setNotice('服务器离线，已请求唤醒；可刷新确认或手动重试唤醒。');
      })
      .catch((error) => {
        if (!controller.signal.aborted) report(error);
      });
    return () => controller.abort();
  }, [host, online, wakeConfigured, mode]);
  async function refreshView(sessionOnly = false) {
    if (refreshPending.current) return refreshPending.current;
    const work = (async () => {
      setRefreshing(true);
      setRefreshed('');
      recoverNotifications();
      try {
        await boundedRefresh(async (signal) => {
          if (mode === 'cw' && host && refreshSession.current) {
            // Catalog/identity recovery must not hold the conversation spinner.
            if (!sessionOnly) {
              void refresh().catch(report);
              void recoverCatalog.current?.().catch(report);
            }
            // A fresh Agent snapshot also confirms reachability.
            await refreshSession.current(signal);
          } else {
            await refresh();
            signal.throwIfAborted();
            if (mode === 'admin') await readAdminSnapshot();
            signal.throwIfAborted();
            if (mode === 'cw' && host) {
              await recoverCatalog.current?.();
              signal.throwIfAborted();
              setRevision((value) => value + 1);
              const confirmation = await api(
                `/hosts/${host}/probe`,
                {},
                signal,
              );
              if (!confirmation.online)
                throw new Error('未确认服务器可达，请重试');
              signal.throwIfAborted();
              await refreshSession.current?.(signal);
            }
          }
          signal.throwIfAborted();
          if (!sessionOnly) setRevision((value) => value + 1);
          setRefreshed(new Date().toLocaleTimeString());
        });
      } catch (error) {
        recoverNotifications(true);
        report(error);
      } finally {
        setRefreshing(false);
        refreshPending.current = undefined;
      }
    })();
    refreshPending.current = work;
    return work;
  }
  useEffect(() => {
    if (!host || !online || catalogHost !== host) return;
    setNotice((current) =>
      current.startsWith('服务器离线，已请求唤醒') ? '服务器已上线' : current,
    );
    const controller = new AbortController();
    void Promise.all([
      api(`/hosts/${host}/projects`, undefined, controller.signal),
      api(`/sessions?paged=true&hostId=${host}`, undefined, controller.signal),
    ])
      .then(([available, result]) => {
        if (controller.signal.aborted) return;
        setError((current) =>
          current.startsWith('HOST_OFFLINE:') ? '' : current,
        );
        const restored = restoreWorkspace(
          savedWorkspace.current,
          host,
          available,
          result.data,
        );
        const currentProject = projectContext.current.project;
        setProjects(available);
        setProject((current) =>
          manualHostSelection.current === host
            ? ''
            : available.some((p: any) => p.id === current)
              ? current
              : restored.projectId,
        );
        setSelected((current) => {
          if (manualHostSelection.current === host) return undefined;
          if (current) {
            if (!available.some((p: any) => p.id === current.projectId))
              return undefined;
            return (
              result.data.find((s: Session) => s.id === current.id) || current
            );
          }
          // Restore once if the local catalog was empty. A deliberate project
          // selection or closing a conversation must not reopen the old session.
          return !currentProject ? restored.session : undefined;
        });
        setSessions(result.data);
        setSessionCursor(result.nextCursor);
        for (const session of result.data)
          observeSessionHeads.current?.(session.id, session.heads);
      })
      .catch((error) => {
        if (!controller.signal.aborted) report(error);
      });
    return () => controller.abort();
  }, [host, online, catalogHost, revision]);
  useEffect(() => {
    if (!grant) return;
    let disposed = false,
      running = false,
      dirty = false,
      finished = false;
    const poll = async () => {
      if (finished || disposed) return;
      if (running) {
        dirty = true;
        return;
      }
      running = true;
      dirty = false;
      try {
        if (grant.expires <= Date.now())
          throw new Error('登录请求已过期，请重新申请');
        const result = await api('/auth/device/poll', { id: grant.id });
        if (disposed) return;
        if (result.state === 'approved') {
          finished = true;
          if (grant.requestedHostId && result.hostId !== grant.requestedHostId)
            throw new Error('批准的服务器与申请目标不一致，请重新申请。');
          setGrant(undefined);
          setAdding(false);
          if (currentMode.current === 'cw') {
            setPanel(null);
            setView('chat');
          }
          setHost(result.hostId);
          await refresh();
        } else if (result.state === 'rejected') {
          finished = true;
          setGrant(undefined);
          setError(
            grant.requestedHostId
              ? '目标服务器或管理员已拒绝登录申请'
              : '管理员已拒绝登录申请',
          );
        }
      } catch (e) {
        if (!disposed) {
          report(e);
        }
      } finally {
        running = false;
        if (dirty && !finished && !disposed) void poll();
      }
    };
    const stop = observe(
      `/api/v1/auth/device/events?id=${grant.id}`,
      (event) => {
        if (event.type === 'subscribed' || event.type === 'change') void poll();
      },
    );
    const expiry = setTimeout(
      () => {
        if (!disposed) {
          setGrant(undefined);
          setError('登录请求已过期，请重新申请');
        }
      },
      Math.max(0, grant.expires - Date.now()),
    );
    return () => {
      disposed = true;
      stop();
      clearTimeout(expiry);
    };
  }, [grant, revision]);
  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    setCatalogHost('');
    catalogScope.current = '';
    savedWorkspace.current = undefined;
    setProjects([]);
    setProject('');
    setSessions([]);
    setSelected(undefined);
    setTakeover(false);
    operations.current?.stop();
    operations.current = null;
    catalog.current?.close();
    catalog.current = null;
    if (!host) return;
    rememberHost(host);
    let cache: HistoryCache | undefined;
    let operationClient: OperationClient | undefined;
    let loading: Promise<void> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let loadError: unknown;
    const load = (): Promise<void> => {
      if (disposed || catalogScope.current === host) return Promise.resolve();
      if (loading) return loading;
      clearTimeout(retryTimer);
      loading = (async () => {
        try {
          const { identity } = await api(
            `/client/identity?hostId=${encodeURIComponent(host)}`,
            undefined,
            controller.signal,
          );
          if (disposed) return;
          cache = new HistoryCache(
            JSON.stringify([location.origin, identity, host]),
          );
          const [stored, navigation] = await Promise.all([
            cache.record('catalog').catch(() => undefined),
            cache.record('workspace').catch(() => undefined),
          ]);
          if (disposed) return;
          const restored = restoreWorkspace(
            navigation,
            host,
            stored?.projects || [],
            stored?.sessions || [],
          );
          savedWorkspace.current =
            manualHostSelection.current === host ? undefined : navigation;
          setProjects(stored?.projects || []);
          const pending = welcomeSelection.current;
          const continued =
            pending?.hostId === host ? pending.session : undefined;
          if (continued) welcomeSelection.current = undefined;
          setProject(
            manualHostSelection.current === host
              ? ''
              : continued?.projectId || restored.projectId,
          );
          setSessions(stored?.sessions || []);
          setSelected(
            manualHostSelection.current === host
              ? undefined
              : continued || restored.session,
          );
          catalog.current = cache;
          operationClient = new OperationClient(cache, {
            host,
            owner: identity,
          });
          operations.current = operationClient;
          void operationClient.start().catch(report);
          catalogScope.current = host;
          setCatalogHost(host);
        } catch (e) {
          loadError = e;
          if (!disposed) {
            report(e);
            if (retryable(e) && attempts < 3)
              retryTimer = setTimeout(
                () => void load(),
                1000 * 2 ** attempts++,
              );
          }
        }
      })().finally(() => {
        loading = undefined;
      });
      return loading;
    };
    recoverCatalog.current = async () => {
      attempts = 0;
      await load();
      if (!disposed && catalogScope.current !== host) throw loadError;
    };
    void load();
    return () => {
      disposed = true;
      recoverCatalog.current = undefined;
      clearTimeout(retryTimer);
      controller.abort();
      operationClient?.stop();
      cache?.close();
    };
  }, [host, emailIdentity.accountId]);
  useEffect(() => {
    if (catalogHost !== host || catalogScope.current !== host || !project)
      return;
    const navigation: WorkspaceState = {
      projectId: project,
      ...(selected?.projectId === project ? { session: selected } : {}),
    };
    savedWorkspace.current = navigation;
    void catalog.current?.record('workspace', navigation).catch(() => {
      setNotice('本机浏览状态未能保存，刷新后可能无法恢复当前会话。');
    });
  }, [host, catalogHost, project, selected]);
  useEffect(() => {
    if (projects.length && catalog.current && catalogScope.current === host)
      void catalog.current
        .record('catalog', { projects, sessions })
        .catch(() => {});
  }, [host, projects, sessions]);
  useEffect(() => {
    let disposed = false;
    setCreateOperation(undefined);
    void operations.current
      ?.records()
      .then((records) => {
        const original = records.find(
          (record) =>
            record.path === '/sessions' &&
            record.meta?.projectId === project &&
            record.state !== 'confirmed',
        );
        if (!disposed && original)
          setCreateOperation({
            requestId: original.requestId,
            ...(typeof original.meta?.threadId === 'string'
              ? { threadId: original.meta.threadId }
              : {}),
          });
      })
      .catch(report);
    return () => {
      disposed = true;
    };
  }, [host, project, catalogHost]);
  useEffect(() => {
    if (!createOperation || !host || !project || !operations.current) return;
    let disposed = false;
    const controller = new AbortController();
    const client = operations.current;
    void client
      .resume(createOperation.requestId, controller.signal)
      .then((session: Session) => {
        if (disposed) return;
        setSessions((sessions) => [
          session,
          ...sessions.filter((s) => s.id !== session.id),
        ]);
        setSelected(session);
        setTakeover(false);
        setPanel(null);
        setCreateOperation(undefined);
      })
      .catch(async (error) => {
        if (
          disposed ||
          error?.name === 'AbortError' ||
          error?.code === 'NOT_FOUND'
        )
          return;
        const original = (await client.records().catch(() => [])).find(
          (record) => record.requestId === createOperation.requestId,
        );
        if (disposed) return;
        if (original?.result?.error) setCreateOperation(undefined);
        report(error);
      });
    return () => {
      disposed = true;
      controller.abort();
    };
  }, [host, project, catalogHost, createOperation?.requestId]);
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
  }, [events, view, promptProgress, busy, unconfirmed]);
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
    setControlElsewhere(false);
    setError((current) =>
      current.startsWith('SESSION_CLOSED:') ||
      current === '此会话正在其他页面使用。'
        ? ''
        : current,
    );
    setEvents([]);
    setHasOlder(false);
    setLoadingHistory(false);
    setHistoryNotice('');
    setProjectReadOnly(false);
    setTerminalControl(undefined);
    messageScrollTop.current = 0;
    historyAnchor.current = null;
    setContentChunks({});
    setReadingContent({});
    olderView.current = false;
    setApprovals([]);
    setText('');
    setUnconfirmed(undefined);
    setPromptProgress(undefined);
    setSelectedModel('');
    pendingCommand.current = undefined;
    followMessages.current = true;
    if (!selected) return;
    let disposed = false,
      timer: ReturnType<typeof setTimeout>,
      handshake: ReturnType<typeof setTimeout>,
      attempt = 0;
    let historySubscriberSync: (() => void) | undefined;
    let commandDelivery: CommandDelivery | undefined;
    let reliableCommands = false;
    let activeTask = selected.activeTask;
    let commandController = '';
    let controlBinding: { control: unknown; controller: string } | undefined;
    let controlSynced = false;
    let deliveryLoadReady: () => void;
    const deliveryLoaded = new Promise<void>((resolve) => {
      deliveryLoadReady = resolve;
    });
    const openDelivery = () => {
      const ws = socket.current;
      if (
        reliableCommands &&
        commandDelivery &&
        ws?.readyState === WebSocket.OPEN
      )
        void commandDelivery
          .connect((frame) => {
            if (!disposed && socket.current === ws)
              ws.send(JSON.stringify(frame));
          }, controlBinding)
          .catch(report);
    };
    deliverCommand.current = async (command) => {
      {
        if (!commandDelivery) throw new Error('本机存储尚未就绪');
        if (command.action === 'interrupt') {
          const pending = pendingCommand.current;
          if (
            pending &&
            (await commandDelivery.cancelUnpublished(pending.requestId))
          ) {
            pendingCommand.current = undefined;
            setUnconfirmed(undefined);
            setPending(false);
            setPromptProgress(undefined);
            setText((current) => current || pending.text || '');
            await cache?.record('pending', null);
            setNotice('已在本机取消，任务尚未发送。');
            return;
          }
          const target =
            (pending
              ? await commandDelivery.target(pending.requestId, activeTask)
              : undefined) || activeTask;
          if (!target)
            throw new Error('尚未取得任务身份，请刷新状态后再停止。');
          command = { ...command, target };
        }
        if (command.action === 'queueRun' && activeTask)
          command = { ...command, target: activeTask };
        await commandDelivery.submit(command);
      }
    };
    after.current = 0;
    setEvents([]);
    setApprovals([]);
    setReady(false);
    setPending(false);
    let running = selected.state === 'ready' && selected.running;
    setBusy(running);
    const seen = new Map<number, number>();
    let stateSeq = 0;
    let queueSeq = 0;
    const displayEvents = new Map<number, Event>();
    let displayTimer: ReturnType<typeof setTimeout> | undefined;
    const flushDisplay = () => {
      clearTimeout(displayTimer);
      displayTimer = undefined;
      const pending = [...displayEvents.values()];
      displayEvents.clear();
      if (disposed || !pending.length) return;
      setEvents((v) => {
        if (olderView.current) {
          const visible = new Set(v.map((event) => event.seq));
          return mergeEvents([
            ...v,
            ...pending.filter((event) => visible.has(event.seq)),
          ]);
        }
        const merged = eventWindow([...v, ...pending]);
        if (v.length && merged[0]?.seq > v[0].seq) setHasOlder(true);
        setOlderCursor(merged[0]?.seq ?? 0);
        return merged;
      });
    };
    const add = (e: Event, live = true) => {
      const revision = e.revision ?? e.seq;
      if ((seen.get(e.seq) ?? -1) >= revision) return;
      seen.set(e.seq, revision);
      if (seen.size > 2000) seen.delete(seen.keys().next().value!);
      after.current = Math.max(after.current, e.seq);
      {
        displayEvents.set(e.seq, e);
        if (
          displayEvents.size >= 200 ||
          (live && !e.type.endsWith('delta') && !e.type.endsWith('Delta'))
        )
          flushDisplay();
        else if (!displayTimer) displayTimer = setTimeout(flushDisplay, 16);
      }
      const d = e.data as any;
      if (e.type === 'promptQueueChanged' && e.seq > queueSeq) {
        queueSeq = e.seq;
        setSelected((current) =>
          current?.id === selected.id
            ? { ...current, promptQueue: d.queue }
            : current,
        );
      }
      if (!live) return;
      if (
        running &&
        e.seq > stateSeq &&
        ((e.type === 'item/agentMessage/delta' && d.delta) ||
          (['item/started', 'item/completed'].includes(e.type) &&
            d.item?.type === 'agentMessage' &&
            d.item.text))
      )
        setPromptProgress('replying');
      if (e.type === 'sessionClosed') {
        setApprovals([]);
        setReady(false);
        setStatus(
          d.error?.incomplete
            ? '历史容量不足，任务已停止；部分输出未保存。'
            : '会话已结束',
        );
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
      if (e.type === 'externalState') {
        running = d.running;
        setBusy(d.running);
        if (!running) setPromptProgress(undefined);
        setSelected((current) =>
          current?.id === selected.id
            ? {
                ...current,
                running: d.running,
                externalStatus: d.externalStatus,
                ...(d.approvalForwarding !== undefined
                  ? { approvalForwarding: d.approvalForwarding }
                  : {}),
                ...(d.historySyncPending !== undefined
                  ? { historySyncPending: d.historySyncPending }
                  : {}),
              }
            : current,
        );
      }
      if (
        e.type === 'autoApprovalChanged' &&
        typeof d.autoApproval === 'boolean'
      )
        setSelected((current) =>
          current?.id === selected.id
            ? { ...current, autoApproval: d.autoApproval }
            : current,
        );
      if (e.type === 'approval')
        setApprovals((v) => [
          ...v.filter((a) => a.approvalId !== d.approvalId),
          d,
        ]);
      if (e.type === 'approvalSubmitted')
        setApprovals((v) =>
          v.map((a) =>
            a.approvalId === d.approvalId ? { ...a, submitted: true } : a,
          ),
        );
      if (e.type === 'approvalResolved')
        setApprovals((v) => v.filter((a) => a.approvalId !== d.approvalId));
      if (
        e.seq > stateSeq &&
        ['turn/started', 'turn/completed', 'sessionClosed'].includes(e.type)
      ) {
        stateSeq = e.seq;
        running = e.type === 'turn/started';
        if (e.type === 'turn/completed') setApprovals([]);
        if (e.type === 'turn/started') activeTask = d.activeTask;
        setBusy(running);
        setPromptProgress(e.type === 'turn/started' ? 'waiting' : undefined);
      }
    };
    const controller = new AbortController();
    let terminal = false;
    let connecting = false;
    let takeoverPending = takeover;
    const retry = () => {
      if (disposed || terminal) return;
      clearTimeout(timer);
      timer = setTimeout(() => void connect(), recoveryDelay(attempt));
      attempt = Math.min(attempt + 1, 3);
    };
    const checkPending = async () => {
      // Recovery belongs to the durable command journal, including saved results.
      await commandDelivery?.refresh().catch(report);
    };
    const observeHeads = (heads: any) => {
      if (typeof heads?.agent !== 'number') return;
      historySync.observe(heads.agent, undefined);
      if (
        (historySync.received === undefined || historySync.missing) &&
        !syncTimer
      )
        syncTimer = setTimeout(() => {
          syncTimer = undefined;
          if (historySync.received === undefined || historySync.missing)
            void refreshSession.current?.().catch(report);
        }, 100);
    };
    observeSessionHeads.current = (id, heads) => {
      if (id === selected.id) observeHeads(heads);
    };
    const connect = async () => {
      if (disposed || terminal || connecting) return;
      clearTimeout(timer);
      connecting = true;
      setStatus(attempt ? '正在重连' : '正在连接');
      setReady(false);
      try {
        await deliveryLoaded;
        if (disposed) return;
        const claim = await commandDelivery?.claim();
        const ticket = await api(
          `/sessions/${selected.id}/${takeoverPending ? 'takeover' : 'attach'}`,
          claim || {},
          controller.signal,
        );
        takeoverPending = false;
        if (disposed) return;
        const ws = businessSocket(
          location.origin.replace(/^http/, 'ws') +
            relaySocketPath('/ws/v1/web/' + selected.id),
        );
        socket.current = ws;
        handshake = setTimeout(() => disconnect(4000), 15000);
        ws.onopen = () => {
          if (!disposed && socket.current === ws)
            ws.send(
              JSON.stringify({
                type: 'auth',
                ticket: ticket.ticket,
                events: 'history',
              }),
            );
        };
        ws.onmessage = (message) => {
          if (disposed || socket.current !== ws) return;
          try {
            const d = JSON.parse(message.data);
            observeHeads(d.heads);
            if (d.receiptId)
              ws.send(
                JSON.stringify({ type: 'receipt', receiptId: d.receiptId }),
              );
            if (
              typeof d.requestId === 'string' &&
              d.requestId.startsWith('policy-') &&
              ['ack', 'error'].includes(d.type)
            ) {
              const request = policyRequests.current.get(d.requestId);
              if (request) {
                clearTimeout(request.timer);
                policyRequests.current.delete(d.requestId);
                if (d.type === 'error')
                  request.reject(new Error(d.error.message));
                else if (typeof d.result?.autoApproval === 'boolean') {
                  setSelected((current) =>
                    current?.id === selected.id
                      ? { ...current, autoApproval: d.result.autoApproval }
                      : current,
                  );
                  request.resolve();
                } else
                  request.reject(
                    new Error(t('自动批准设置未确认，请重新连接核对。')),
                  );
              }
              return;
            }
            const modelRequest = modelRequests.current.get(d.requestId);
            if (modelRequest && (d.type === 'ack' || d.type === 'error')) {
              clearTimeout(modelRequest.timer);
              modelRequests.current.delete(d.requestId);
              if (d.type === 'error')
                modelRequest.reject(new Error(d.error.message));
              else {
                const page = modelPageSchema.safeParse(d.result);
                if (page.success) modelRequest.resolve(page.data);
                else
                  modelRequest.reject(
                    new Error(t('模型列表格式不兼容，请升级 Agent / Codex。')),
                  );
              }
              return;
            }
            // Late catalog replies must not clear an unrelated task/approval submission.
            if (
              ['ack', 'error'].includes(d.type) &&
              typeof d.requestId === 'string' &&
              d.requestId.startsWith('models-')
            )
              return;
            if (d.type === 'delivery-rejected') {
              commandDelivery?.disconnect();
              setReady(false);
              if (['SESSION_BUSY', 'STALE_CONTROLLER'].includes(d.error.code)) {
                setReady(false);
                setControlElsewhere(true);
                setError('此会话正在其他页面使用。');
              } else setError(d.error.code + ': ' + d.error.message);
              return;
            }
            if (
              d.type === 'delivery-window' ||
              d.type === 'delivery-result' ||
              d.type === 'delivery-reset'
            ) {
              void commandDelivery
                ?.receive(d)
                .then(() => {
                  if (
                    !disposed &&
                    socket.current === ws &&
                    commandDelivery?.ready &&
                    !controlSynced
                  ) {
                    controlSynced = true;
                    ws.send(
                      JSON.stringify({
                        action: 'sync',
                        after: Number.MAX_SAFE_INTEGER,
                      }),
                    );
                  }
                })
                .catch(report);
              return;
            }
            if (d.type === 'attached') {
              if (d.delivery !== 2) {
                terminal = true;
                ws.close();
                report(
                  new ApiError(
                    'UPGRADE_REQUIRED',
                    'Business transport delivery:2 required',
                    409,
                  ),
                );
                return;
              }
              reliableCommands = true;
              commandController = d.controller || '';
              const proof = controlProofSchema.safeParse(d.control);
              setTerminalControl(proof.success ? proof.data : undefined);
              controlBinding = {
                control: d.control,
                controller: commandController,
              };
              controlSynced = false;
              openDelivery();
              return;
            }
            if (d.type === 'sync') {
              clearTimeout(handshake);
              setSelected((current) =>
                current?.id === selected.id && d.session.id === selected.id
                  ? { ...current, ...d.session }
                  : current,
              );
              setApprovals(d.approvals);
              running = d.session.running;
              activeTask = d.session.activeTask;
              setBusy(d.session.running);
              if (!d.session.running && !pendingCommand.current)
                setPromptProgress(undefined);
              for (const e of d.events) add(e);
              if (d.gap) setError('部分历史已清理，当前显示保留记录。');
              if (d.more)
                ws.send(
                  JSON.stringify({ action: 'sync', after: after.current }),
                );
              else {
                setReady(true);
                setControlElsewhere(false);
                setError((current) =>
                  current === '此会话正在其他页面使用。' ? '' : current,
                );
                setStatus('已连接');
                attempt = 0;
                terminal = false;
                setPending(false);
                void checkPending();
              }
              return;
            }
            if (d.type === 'event') add(d.event);
            if (d.type === 'ack') {
              if (d.result?.state === 'approval-submitted')
                setNotice('审批决定已发送，等待原客户端确认；请勿重复提交。');
              if (d.result?.state === 'queued')
                setNotice(
                  '已加入原客户端队列，等待原客户端执行；审批仍在原客户端处理。',
                );
              if (pendingCommand.current?.requestId === d.requestId) {
                if (pendingCommand.current?.action !== 'enqueue')
                  setPromptProgress((progress) =>
                    promptAcknowledged(
                      progress,
                      d.result?.state === 'queued',
                      running,
                      stateSeq,
                      d.result?.history?.seq,
                    ),
                  );
                pendingCommand.current = undefined;
                setUnconfirmed(undefined);
                void cache?.record('pending', null);
              }
              setPending(false);
            }
            if (d.type === 'error') {
              if (d.error.code === 'PROJECT_READ_ONLY') {
                terminal = true;
                clearTimeout(handshake);
                setProjectReadOnly(true);
                setReady(false);
                setPending(false);
                setStatus('只读会话 · 同项目已有写会话');
                return;
              }
              setPending(false);
              if (
                d.requestId === pendingCommand.current?.requestId &&
                pendingCommand.current?.action !== 'enqueue'
              )
                setPromptProgress(undefined);
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
              if (['SESSION_BUSY', 'STALE_CONTROLLER'].includes(d.error.code)) {
                setReady(false);
                setControlElsewhere(true);
                setError('此会话正在其他页面使用。');
              } else setError(d.error.code + ': ' + d.error.message);
            }
          } catch (e) {
            report(e);
          }
        };
        const disconnect = (code: number) => {
          if (socket.current !== ws) return;
          socket.current = null;
          commandDelivery?.disconnect();
          ws.close();
          clearTimeout(handshake);
          if (disposed) return;
          for (const request of modelRequests.current.values()) {
            clearTimeout(request.timer);
            request.reject(new Error(t('连接已断开，请重新加载模型。')));
          }
          modelRequests.current.clear();
          for (const request of policyRequests.current.values()) {
            clearTimeout(request.timer);
            request.reject(
              new Error(t('自动批准设置未确认，请重新连接核对。')),
            );
          }
          policyRequests.current.clear();
          setReady(false);
          setPending(false);
          setStatus('已断开');
          if (code === 4009) {
            terminal = true;
            setStatus('只读观察 · 其他设备控制');
            setControlElsewhere(true);
            setError('此会话正在其他页面使用。');
            return;
          }
          if (code === 4001) {
            terminal = true;
            setError('登录已过期或被撤销，请重新登录');
            return;
          }
          retry();
        };
        ws.onclose = (e) => disconnect(e.code);
        ws.onerror = () => {
          if (!disposed && socket.current === ws) setStatus('连接错误');
        };
      } catch (e) {
        if (!disposed) {
          if (e instanceof ApiError && e.code === 'PROJECT_READ_ONLY') {
            terminal = true;
            setProjectReadOnly(true);
            setStatus('只读会话 · 同项目已有写会话');
            return;
          }
          if (
            e instanceof ApiError &&
            ['SESSION_BUSY', 'STALE_CONTROLLER'].includes(e.code)
          ) {
            setControlElsewhere(true);
            setError('此会话正在其他页面使用。');
          } else if (!retryable(e)) report(e);
          setStatus(
            retryable(e)
              ? '连接中断，正在等待恢复；远程任务可能仍在执行'
              : '只读观察 · 无法取得控制权',
          );
          if (retryable(e)) retry();
          else terminal = true;
        }
      } finally {
        connecting = false;
      }
    };
    let historyTimer: ReturnType<typeof setTimeout>;
    let historyAttempts = 0;
    let historyFrozen = false;
    let cache: HistoryCache | undefined;
    let historySubscription: HistorySubscription | undefined;
    const historySync = new HistorySync();
    let syncRequest: string | undefined;
    let historyReplyTimer: ReturnType<typeof setTimeout> | undefined;
    let historyReady = false;
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
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
    const applyHistoryGap = (page: HistoryPage) => {
      if (!page.gap) return;
      if (page.historyVersion !== 2)
        throw new Error('Unsupported history gap protocol');
      for (const [seq, revision] of seen)
        if (revision <= page.snapshotSeq) seen.delete(seq);
      for (const [seq, event] of displayEvents)
        if ((event.revision ?? event.seq) <= page.snapshotSeq)
          displayEvents.delete(seq);
      setEvents((previous) =>
        previous.filter(
          (event) => (event.revision ?? event.seq) > page.snapshotSeq,
        ),
      );
      setContentChunks({});
      olderView.current = false;
      setHistoryNotice('部分旧历史已过期，已恢复当前保留快照。');
    };
    const showPage = (page: HistoryPage) => {
      if (page.snapshotGeneration !== undefined)
        historySync.generation = Math.max(
          historySync.generation ?? 0,
          page.snapshotGeneration,
        );
      applyHistoryGap(page);
      if (olderView.current) captureHistoryAnchor();
      setEvents((previous) => {
        const merged = mergeEvents([...page.events, ...previous]);
        return olderView.current ? merged : eventWindow(merged);
      });
      setOlderCursor(page.events[0]?.seq ?? 0);
      setHasOlder(page.more);
      finishPage();
    };
    const requestPage = (before = 0, force = false, bypassCache = false) => {
      if (disposed) return;
      if (force) {
        pageGeneration++;
        for (const [id, request] of requests)
          if (typeof request === 'number') requests.delete(id);
        finishPage();
      }
      if (pageLoading) return;
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
        if (cache && !bypassCache) {
          const stored = before
            ? await cache.page(before).catch(() => undefined)
            : await cache.recent().catch(() => undefined);
          if (disposed || generation !== pageGeneration) return;
          if (stored) {
            showPage(stored);
            return;
          }
        }
        if (!before && reliableCommands) {
          try {
            const snapshot = await readApi(
              `/sessions/${selected.id}/snapshot?historyVersion=2`,
              controller.signal,
            );
            if (disposed || generation !== pageGeneration) return;
            showPage(snapshot.history);
            historySync.snapshot(snapshot.history);
            void cache
              ?.writeSnapshot(
                snapshot.history.events,
                historySync.received,
                0,
                snapshot.history,
              )
              .catch(cacheError);
          } catch (error) {
            if (!disposed && generation === pageGeneration) {
              finishPage();
              report(error);
            }
          }
          return;
        }
        const hs = historySocket.current;
        if (hs?.readyState !== WebSocket.OPEN) {
          finishPage();
          setHistoryNotice('较早内容尚未缓存，连接恢复后可重试。');
          return;
        }
        const requestId = crypto.randomUUID();
        requests.set(requestId, before);
        hs.send(
          JSON.stringify({
            operation: 'page',
            historyVersion: 2,
            ...(before && historySync.generation !== undefined
              ? { snapshotGeneration: historySync.generation }
              : {}),
            before,
            requestId,
          }),
        );
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
        const reference = await cache
          ?.reference(seq, revision)
          .catch(() => undefined);
        if (disposed || contentReads.get(seq)?.requestId !== requestId) return;
        if (stored) {
          finishRead(seq);
          setContentChunks((v) => ({
            ...v,
            [seq]: {
              ...stored,
              text:
                offset && v[seq]?.revision === revision
                  ? v[seq].text + stored.text
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
            ...(reference ? { reference } : {}),
          }),
        );
      })();
    };
    const connectHistory = async () => {
      if (disposed || historyFrozen) return;
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
          const deliveryId = await deliveryIdentity();
          if (disposed) return;
          const deliveryCache = cache;
          commandDelivery = new CommandDelivery(
            {
              record: (key, value) =>
                deliveryCache.record(key + ':' + deliveryId, value),
            },
            (payload) => {
              const ws = socket.current;
              if (!disposed && ws)
                ws.onmessage?.(
                  new MessageEvent('message', {
                    data: JSON.stringify(payload),
                  }),
                );
            },
            {
              heads: observeHeads,
              content: async (stream, lane, allocation, resultSeq, offset) =>
                readApi(
                  `/sessions/${selected.id}/delivery?stream=${stream}&lane=${lane}&instance=${allocation.instance}&streamSerial=${allocation.streamSerial}&creditGeneration=${allocation.creditGeneration}&contentSeq=${resultSeq}&offset=${offset}`,
                  controller.signal,
                ),
              read: async (stream, lane, seq, exchangeId, receipt) =>
                readApi(
                  `/sessions/${selected.id}/delivery?stream=${stream}&lane=${lane}${exchangeId ? `&exchangeId=${exchangeId}` : ''}${seq === undefined ? '' : `&seq=${seq}`}${receipt ? `&resultReceived=${receipt.received}&resultBytes=${receipt.bytes}${receipt.instance ? `&instance=${receipt.instance}&streamSerial=${receipt.streamSerial}&creditGeneration=${receipt.creditGeneration}` : ''}` : ''}`,
                  controller.signal,
                  commandController
                    ? { 'X-CoC-Controller': commandController }
                    : undefined,
                ),
              send: async (frame) => {
                if (disposed || !commandController)
                  throw new Error('Controller is unavailable');
                try {
                  await api(
                    `/sessions/${selected.id}/delivery`,
                    { ...(frame as object), controller: commandController },
                    controller.signal,
                  );
                } catch (error) {
                  if (
                    authorizationFailed(error) ||
                    (error instanceof ApiError &&
                      error.code === 'STALE_CONTROLLER')
                  ) {
                    commandDelivery?.disconnect();
                    report(error);
                  }
                  throw error;
                }
              },
            },
          );
          deliveryLoadReady!();
          openDelivery();
          const savedDraft = await cache.record('draft').catch(() => undefined);
          const savedModel = await cache.record('model').catch(() => undefined);
          const savedPending = await cache
            .record('pending')
            .catch(() => undefined);
          if (disposed) return;
          const restoredModel = modelIdSchema.safeParse(savedModel);
          if (restoredModel.success) setSelectedModel(restoredModel.data);
          setText((current) => current || savedDraft || '');
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
            historySync.restore(stored.checkpoint);
            setEvents((v) => eventWindow([...stored.events, ...v]));
            setOlderCursor(stored.events[0]?.seq ?? 0);
            setHasOlder(stored.events.length > 0);
          }
        }
        deliveryLoadReady!();
        if (cache && !historySubscription) {
          historySubscription = await HistorySubscription.create(
            cache,
            'history-subscription:' + (await deliveryIdentity()),
            (maximum) => {
              historySync.observe(maximum, undefined);
              if (historySync.received === undefined || historySync.missing)
                historySubscriberSync?.();
            },
            () => {
              clearTimeout(historyReplyTimer);
              historyReady = true;
              historySubscriberSync?.();
            },
            (error) => {
              historyFrozen = true;
              clearTimeout(historyReplyTimer);
              report(error);
              historySocket.current?.close();
            },
          ).catch((error: unknown) => {
            cacheError();
            report(error);
            return undefined; // Read-only pagination still works without a durable subscription.
          });
          cache.onCommit = () => historySubscription?.commit();
          cache.onClear = () => {
            historySubscription?.stop();
            historySubscription = undefined;
            historySync.reset();
            historyFrozen = false;
            if (historySocket.current) historySocket.current.close();
            else void connectHistory();
          };
        }
        if (disposed) return;
        const hs = businessSocket(
          location.origin.replace(/^http/, 'ws') +
            relaySocketPath('/ws/v1/history/' + selected.id),
        );
        historySocket.current = hs;
        historyReady = false;
        clearTimeout(historyReplyTimer);
        historyReplyTimer = setTimeout(() => disconnect(), 15000);
        const sync = (force = false) => {
          if (force && syncRequest) {
            requests.delete(syncRequest);
            syncRequest = undefined;
          }
          if (
            disposed ||
            historySocket.current !== hs ||
            !historyReady ||
            syncRequest
          )
            return;
          clearTimeout(syncTimer);
          syncTimer = undefined;
          const requestId = crypto.randomUUID();
          requests.set(requestId, 'sync');
          syncRequest = requestId;
          clearTimeout(historyReplyTimer);
          historyReplyTimer = setTimeout(() => {
            disconnect();
          }, 15000);
          hs.send(
            JSON.stringify({
              operation: 'page',
              historyVersion: 2,
              requestId,
              ...(historySync.received === undefined
                ? {}
                : { after: historySync.received }),
            }),
          );
        };
        historySubscriberSync = () => sync();
        hs.onmessage = (message) => {
          if (disposed || historySocket.current !== hs) return;
          try {
            const d = JSON.parse(message.data);
            if (d.receiptId)
              hs.send(
                JSON.stringify({ type: 'receipt', receiptId: d.receiptId }),
              );
            if (d.type === 'history-ready') {
              if (historySubscription)
                historySubscription.connect((frame) => {
                  if (
                    !disposed &&
                    historySocket.current === hs &&
                    hs.readyState === WebSocket.OPEN
                  )
                    hs.send(JSON.stringify(frame));
                });
              else {
                clearTimeout(historyReplyTimer);
                historyReady = true;
                sync();
              }
              return;
            }
            if (['history-window', 'history-dirty'].includes(d.type)) {
              void historySubscription?.handle(d);
              return;
            }
            if (d.type === 'event') {
              if (!historyReady) return;
              add(d.event);
              historySync.observe(d.maxRevision, d.previousRevision);
              cache?.writeLive(d.event, cacheError, historySync.received);
              if (historySync.missing && !syncRequest && !syncTimer)
                syncTimer = setTimeout(() => {
                  syncTimer = undefined;
                  sync();
                }, 100);
              return;
            }
            if (d.type === 'error') {
              void historySubscription?.handle(d);
              if (
                d.error?.code === 'HISTORY_SNAPSHOT_CHANGED' &&
                typeof requests.get(d.requestId) === 'number'
              ) {
                historySync.generation = undefined;
                requestPage(0, true, true);
                return;
              }
              if (d.requestId === syncRequest) {
                syncRequest = undefined;
                disconnect();
              }
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
                  if (
                    ['CONTENT_CHANGED', 'CONTENT_EXPIRED'].includes(
                      d.error.code,
                    )
                  ) {
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
            historyAttempts = 0;
            if (d.text !== undefined) {
              if (contentReads.get(d.seq)?.requestId !== d.requestId) return;
              finishRead(d.seq);
              void cache
                ?.content(d.seq, d.offset, d.revision, d)
                .catch(cacheError);
              setContentChunks((v) => ({
                ...v,
                [d.seq]: {
                  text:
                    d.offset && v[d.seq]?.revision === d.revision
                      ? v[d.seq].text + d.text
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
              clearTimeout(historyReplyTimer);
              // Complete the missing range; later live frames cannot rewind either watermark.
              syncRequest = undefined;
              applyHistoryGap(d);
              historySync.snapshot(d);
              for (const e of d.events) add(e, false);
              const committed = cache?.writeSnapshot(
                d.events,
                historySync.received,
                d.direction === 'before' ? 0 : undefined,
                d.direction === 'before' ? d : undefined,
              );
              if (d.direction === 'before') {
                if (!olderView.current) {
                  setOlderCursor(d.events[0]?.seq ?? 0);
                  setHasOlder(d.more);
                }
              }
              void Promise.resolve(committed)
                .catch(cacheError)
                .then(() => {
                  if (disposed || historySocket.current !== hs) return;
                  historySubscription?.commit();
                  if (
                    (d.direction === 'after' && d.more) ||
                    historySync.missing
                  )
                    sync();
                })
                .catch(cacheError);
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
        const disconnect = (revoked = false) => {
          if (disposed || historySocket.current !== hs) return;
          if (revoked) historyFrozen = true;
          historySocket.current = null;
          historySubscription?.disconnect();
          hs.close();
          clearTimeout(historyReplyTimer);
          historyReady = false;
          syncRequest = undefined;
          clearTimeout(syncTimer);
          syncTimer = undefined;
          for (const seq of contentReads.keys()) finishRead(seq);
          requests.clear();
          pageGeneration++;
          finishPage();
          if (!disposed && !historyFrozen)
            historyTimer = setTimeout(
              () => void connectHistory(),
              historyAttempts++ < 3 ? 3000 : 30000 + Math.random() * 30000,
            );
        };
        hs.onclose = (event) =>
          disconnect(event.code === 4001 || event.code === 4000);
      } catch (e) {
        if (!disposed) {
          report(e);
          if (retryable(e))
            historyTimer = setTimeout(
              () => void connectHistory(),
              historyAttempts++ < 3 ? 5000 : 30000 + Math.random() * 30000,
            );
        }
      }
    };
    let sessionSync: Promise<void> | undefined;
    const confirmSession = async (refreshSignal?: AbortSignal) => {
      const signal = refreshSignal
        ? AbortSignal.any([controller.signal, refreshSignal])
        : controller.signal;
      try {
        signal.throwIfAborted();
        void commandDelivery?.refresh().catch(report);
        signal.throwIfAborted();
        {
          // A direct read does not depend on either session socket, and never
          // acquires control or resends a mutation.
          for (;;) {
            const before = historySync.received;
            const snapshot = await readApi(
              `/sessions/${selected.id}/snapshot?historyVersion=2${before === undefined ? '' : `&after=${before}`}`,
              signal,
            );
            if (disposed) return;
            const page = snapshot.history;
            if (page.snapshotSeq >= historySync.maximum) {
              setSelected((current) =>
                current?.id === selected.id
                  ? { ...current, ...snapshot.session }
                  : current,
              );
              setApprovals(snapshot.approvals);
              running = snapshot.session.running;
              activeTask = snapshot.session.activeTask;
              stateSeq = Math.max(stateSeq, page.snapshotSeq);
              setBusy(running);
              setPromptProgress((progress) =>
                pendingCommand.current
                  ? progress
                  : running
                    ? 'waiting'
                    : undefined,
              );
            }
            applyHistoryGap(page);
            historySync.snapshot(page);
            for (const event of page.events) add(event, false);
            await cache
              ?.writeSnapshot(
                page.events,
                historySync.received,
                page.direction === 'before' ? 0 : undefined,
                page.direction === 'before' ? page : undefined,
              )
              .catch(cacheError);
            if (page.direction === 'before' && !olderView.current) {
              setOlderCursor(page.events[0]?.seq ?? 0);
              setHasOlder(page.more);
            }
            if (
              !(page.direction === 'after' && page.more) &&
              !historySync.missing
            )
              break;
            if (historySync.received === before)
              throw new Error('History cursor did not advance');
          }
          void checkPending();
          return;
        }
      } catch (error) {
        if (!disposed) throw error;
      }
    };
    refreshSession.current = (signal) => {
      if (!sessionSync)
        sessionSync = confirmSession(signal).finally(() => {
          sessionSync = undefined;
        });
      return sessionSync;
    };
    const recoverControl = () => {
      if (
        document.visibilityState === 'visible' &&
        selected.state === 'ready' &&
        !socket.current &&
        !connecting &&
        !terminal
      ) {
        attempt = 0;
        void connect();
      }
    };
    window.addEventListener('online', recoverControl);
    document.addEventListener('visibilitychange', recoverControl);
    void connectHistory();
    if (selected.state === 'ready') void connect();
    else
      setStatus(
        selected.state === 'starting'
          ? '会话启动中，请稍候。'
          : selected.state === 'closing'
            ? '会话正在结束，请稍候。'
            : selected.state === 'failed'
              ? '会话运行中断，可沿用历史继续对话。'
              : '当前为历史记录，可沿用原对话继续。',
      );
    return () => {
      disposed = true;
      window.removeEventListener('online', recoverControl);
      document.removeEventListener('visibilitychange', recoverControl);
      refreshSession.current = undefined;
      observeSessionHeads.current = undefined;
      deliverCommand.current = undefined;
      commandDelivery?.disconnect();
      historySubscription?.stop();
      for (const request of modelRequests.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(t('连接或会话已切换，请重新加载模型。')));
      }
      modelRequests.current.clear();
      for (const request of policyRequests.current.values()) {
        clearTimeout(request.timer);
        request.reject(new Error(t('自动批准设置未确认，请重新连接核对。')));
      }
      policyRequests.current.clear();
      clearTimeout(displayTimer);
      displayEvents.clear();
      controller.abort();
      void cache
        ?.record('draft', draft.current)
        .catch(() => {})
        .finally(() => cache?.close());
      clearTimeout(historyTimer);
      clearTimeout(historyReplyTimer);
      clearTimeout(syncTimer);
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
  const loadModels = useCallback(
    (cursor?: string): Promise<ModelPage> => {
      const ws = socket.current;
      if (!ready || !online || ws?.readyState !== WebSocket.OPEN)
        return Promise.reject(new Error(t('请先连接会话。')));
      if (selected?.external)
        return Promise.reject(new Error(t('外部会话请在原客户端切换模型。')));
      return new Promise((resolve, reject) => {
        const requestId = 'models-' + crypto.randomUUID();
        const timer = setTimeout(() => {
          modelRequests.current.delete(requestId);
          reject(new Error(t('模型列表读取超时，请重试。')));
        }, 15000);
        modelRequests.current.set(requestId, { resolve, reject, timer });
        try {
          ws.send(
            JSON.stringify({
              action: 'models',
              requestId,
              ...(cursor ? { cursor } : {}),
            }),
          );
        } catch (error) {
          clearTimeout(timer);
          modelRequests.current.delete(requestId);
          reject(error);
        }
      });
    },
    [ready, online, selected?.id, selected?.external],
  );
  const setAutoApproval = (enabled: boolean): Promise<void> => {
    const ws = socket.current;
    if (!ready || !online || ws?.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error(t('请先连接会话。')));
    return new Promise((resolve, reject) => {
      const requestId = 'policy-' + crypto.randomUUID();
      const timer = setTimeout(() => {
        policyRequests.current.delete(requestId);
        reject(new Error(t('自动批准设置未确认，请重新连接核对。')));
        void refreshSession.current?.().catch(report);
      }, 15000);
      policyRequests.current.set(requestId, { resolve, reject, timer });
      try {
        void deliverCommand
          .current?.({ action: 'autoApproval', requestId, enabled })
          .catch((e) => {
            clearTimeout(timer);
            policyRequests.current.delete(requestId);
            reject(e);
          });
      } catch (e) {
        clearTimeout(timer);
        policyRequests.current.delete(requestId);
        reject(e);
      }
    });
  };
  const openModels = () => {
    if (selected?.external) {
      setError('外部会话请在原客户端切换模型。');
      return;
    }
    setPanel('models');
  };
  const send = (data: {
    action: string;
    text?: string;
    [key: string]: unknown;
  }) => {
    if (socket.current?.readyState !== WebSocket.OPEN || !ready || !online)
      return false;
    const isInput = data.action === 'prompt' || data.action === 'enqueue';
    if (isInput && pendingCommand.current) return;
    const command = { ...data, requestId: crypto.randomUUID() };
    const targetSocket = socket.current;
    const targetCache = localHistory.current;
    if (isInput) {
      pendingCommand.current = command;
      setUnconfirmed(command);
      setPending(true);
      if (data.action === 'prompt') setPromptProgress('sending');
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
          await deliverCommand.current?.(command);
          submitted = true;
          if (socket.current !== targetSocket) return;
          if (olderView.current) loadHistory.current(0, true);
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
            if (data.action === 'prompt') setPromptProgress(undefined);
            report(e);
            setPending(false);
          }
        }
      })();
    } else {
      try {
        void deliverCommand.current?.(command).catch((error) => {
          report(error);
          setPending(false);
        });
        setPending(true);
        return true;
      } catch (error) {
        report(error);
        setPending(false);
        return false;
      }
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
          message: deviceMessage,
          ...(requestedHost.trim()
            ? { requestedHostId: requestedHost.trim() }
            : {}),
        });
        if (
          requestedHost.trim() &&
          result.requestedHostId !== requestedHost.trim()
        )
          throw new Error('中继尚不支持指定服务器审批，请升级后重试。');
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
          ? t(
              '停用服务器 {0} 并撤销其所有客户端授权？相关连接会关闭。',
              device.name,
            )
          : t(
              '撤销客户端 {0} 的访问？该客户端连接会关闭，其他授权保留。',
              device?.name || id,
            ),
      )
    )
      return;
    setGenerating(true);
    setError('');
    try {
      await api('/admin/' + action, {
        id,
        ...(action === 'approve' &&
        devices.pending.find((item) => item.id === id)?.role !== 'agent'
          ? {
              hostId:
                devices.pending.find((item) => item.id === id)
                  ?.requestedHostId || approvalHosts[id],
            }
          : {}),
      });
      await readAdminSnapshot();
      await refresh();
    } catch (e) {
      report(e);
    } finally {
      setGenerating(false);
    }
  }
  function continueConversation() {
    if (!selected || !online || creating) return;
    if (selected.state === 'closed' || selected.state === 'failed') {
      if (selected.threadId) void create(selected.threadId);
      return;
    }
    if (selected.state !== 'ready' || projectReadOnly) return;
    if (
      controlElsewhere &&
      !confirm(
        t('此会话正在其他页面使用。是否转到当前页面？原页面将无法继续操作。'),
      )
    )
      return;
    setError('');
    setTakeover(controlElsewhere);
    setReconnect((value) => value + 1);
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
      const client = operations.current;
      if (!client) throw new Error('本机存储尚未就绪，请稍后重试');
      const previous = (await client.records()).find(
        (record) =>
          record.path === '/sessions' &&
          record.meta?.projectId === project &&
          record.state !== 'confirmed',
      );
      if (previous && previous.meta?.threadId !== threadId)
        throw new Error('当前项目有待确认的会话创建请求，请先查询结果。');
      const operation = {
        requestId: previous?.requestId || crypto.randomUUID(),
        ...(threadId ? { threadId } : {}),
      };
      setCreateOperation(operation);
      const s = await client.submit(
        '/sessions',
        {
          hostId: host,
          projectId: project,
          mode: 'web',
          ...(threadId ? { threadId } : {}),
        },
        operation.requestId,
        {
          kind: 'create',
          projectId: project,
          ...(threadId ? { threadId } : {}),
        },
      );
      setCreateOperation(undefined);
      if (
        projectContext.current.host !== host ||
        projectContext.current.project !== project
      )
        return;
      setSessions((v) => [s, ...v.filter((session) => session.id !== s.id)]);
      setTakeover(false);
      setSelected(s);
      setPanel(null);
      void loadThreads();
    } catch (e) {
      if (
        projectContext.current.host !== host ||
        projectContext.current.project !== project
      )
        return;
      const pending = (
        await operations.current?.records().catch(() => undefined)
      )?.find(
        (record) =>
          record.path === '/sessions' &&
          record.meta?.projectId === project &&
          record.state !== 'confirmed',
      );
      if (!pending || pending.result?.error) setCreateOperation(undefined);
      report(e);
    } finally {
      setCreating(false);
    }
  }
  async function endSession(session: Session) {
    const client = operations.current;
    if (!client) throw new Error('本机存储尚未就绪，请稍后重试');
    const path = `/sessions/${session.id}/stop`;
    const previous = (await client.records()).find(
      (record) => record.path === path && record.state !== 'confirmed',
    );
    return client.submit(path, {}, previous?.requestId || crypto.randomUUID(), {
      kind: 'stop',
      sessionId: session.id,
    });
  }
  useEffect(() => {
    if (!closingSession) return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(60000),
    ]);
    void (async () => {
      for (;;) {
        const snapshot = await readApi(
          `/sessions/${closingSession}/snapshot?historyVersion=2`,
          signal,
        );
        if (signal.aborted) return;
        const session = snapshot.session as Session;
        if (session.state === 'closed' || session.state === 'failed') {
          setSessions((current) =>
            current.map((row) => (row.id === session.id ? session : row)),
          );
          setStatus(session.state === 'closed' ? '会话已结束' : '会话结束失败');
          setClosingSession(undefined);
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            signal.removeEventListener('abort', abort);
            resolve();
          };
          const timer = setTimeout(finish, 1000);
          const abort = () => {
            clearTimeout(timer);
            reject(signal.reason);
          };
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    })().catch(() => {
      if (controller.signal.aborted) return;
      setClosingSession(undefined);
      setStatus('结束状态待确认');
      setNotice('结束请求已提交，暂未确认最终状态；请刷新核对，不必重复结束。');
    });
    return () => controller.abort();
  }, [closingSession]);
  const openSessions = () => {
    setView('chat');
    setPanel(null);
    setNavigationOpen(true);
    setMenuOpen(false);
  };
  const switchMode = () => {
    const next = mode === 'cw' ? 'admin' : 'cw';
    setMode(next);
    setMenuOpen(false);
    setView(next === 'admin' ? 'devices' : 'chat');
    setPanel(null);
    setSecret('');
    setNewKey('');
    setError('');
  };
  const emailControls = emailIdentity.enabled && (
    <section className="card">
      <p>
        {t('当前邮箱：')}
        {emailIdentity.email}
      </p>
      <p>{t('已授权服务器随邮箱保存，换浏览器登录后自动恢复。')}</p>
      {emailIdentity.legacy?.map((legacy) => (
        <button
          key={legacy.hostId}
          onClick={() => {
            if (confirm(t('将此浏览器的旧服务器授权关联到当前邮箱？')))
              void api('/auth/email/migrate', { hostId: legacy.hostId })
                .then(() => refresh())
                .catch(report);
          }}
        >
          {t('关联旧授权：')}
          {legacy.name} · {legacy.hostId}
        </button>
      ))}
    </section>
  );
  const loginForm = !checking && (adminLogin ? !admin : !logged || adding) && (
    <form onSubmit={login} className="card login-card">
      <h2>{adminLogin ? t('管理员登录') : t('连接远程服务器')}</h2>
      {adminLogin && emailIdentity.autoAdmin && (
        <button
          type="button"
          onClick={() =>
            void api('/auth/email/admin', {})
              .then(() => refresh())
              .catch(report)
          }
        >
          {t('使用管理员邮箱进入管理')}
        </button>
      )}
      {!adminLogin && emailIdentity.enabled && (
        <p>{t('首次批准后，此邮箱可在其他浏览器直接连接该服务器。')}</p>
      )}
      {adminLogin ? (
        <label>
          {t('所有者密钥')}
          <input
            aria-label={t('所有者密钥')}
            type="password"
            required
            autoComplete="current-password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
      ) : (
        <>
          <small>
            {t(
              '可指定目标服务器，由该 Agent 或管理员批准；留空则由管理员选择。',
            )}
          </small>
          <label>
            {t('设备名称')}
            <input
              aria-label={t('设备名称')}
              required
              maxLength={100}
              disabled={!!grant}
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
            />
          </label>
          <label>
            {t('目标服务器 ID（选填）')}
            <input
              aria-label={t('目标服务器 ID（选填）')}
              maxLength={100}
              disabled={!!grant}
              value={requestedHost}
              onChange={(e) => setRequestedHost(e.target.value)}
              placeholder={t('由服务器所有者提供')}
            />
          </label>
          <label>
            {t('给管理员留言')}
            <textarea
              aria-label={t('给管理员留言')}
              maxLength={1000}
              disabled={!!grant}
              placeholder={t('例如：你的身份、希望访问的服务器或用途（选填）')}
              value={deviceMessage}
              onChange={(e) => setDeviceMessage(e.target.value)}
            />
          </label>
        </>
      )}
      <button type="submit" disabled={generating || (!adminLogin && !!grant)}>
        {adminLogin ? t('登录') : t('申请登录')}
      </button>
      {!adminLogin && grant && (
        <div role="status">
          <p>
            {grant.requestedHostId
              ? t('等待目标服务器或管理员批准，配对码：')
              : t('等待管理员批准，配对码：')}
            <strong>{grant.code}</strong>
          </p>
          <p>
            {t('设备：')}
            {deviceName} ·{' '}
            {grant.requestedHostId
              ? t('目标服务器：{0}', grant.requestedHostId)
              : t('服务器由管理员选择')}
          </p>
          {deviceMessage && (
            <p className="request-message">
              {t('留言：')}
              {deviceMessage}
            </p>
          )}
          <details>
            <summary>{t('请求标识')}</summary>
            <p>{grant.id}</p>
          </details>
          <p>
            {t('有效期至')}{' '}
            {new Date(grant.expires).toLocaleString(localeTag())}
          </p>
        </div>
      )}
      {!adminLogin && (
        <p>
          {t(
            '填写设备名称和留言 → 提交申请 → 目标 Agent 或管理员核对配对码并批准；未指定目标时由管理员选择。每份网页凭证访问一台服务器，长期有效，直到管理员撤销。',
          )}
        </p>
      )}
    </form>
  );
  const workspaceHeader = (
    <WorkspaceHeader
      host={hosts.find((h) => h.id === host)?.name || host}
      project={projects.find((p) => p.id === project)?.name || project}
      status={
        !online
          ? t('服务器离线 · 只读缓存')
          : selected && projectReadOnly
            ? t('只读会话 · 同项目已有写会话')
            : selected?.external
              ? t('外部会话 · 只读同步') +
                (selected.approvalForwarding
                  ? t(' · 可远程审批')
                  : t(' · 审批在原客户端')) +
                (busy ? t(' · 原客户端执行中') : '') +
                (selected.historySyncPending
                  ? t(' · 历史容量不足，等待同步')
                  : '')
              : approvals.length
                ? t('等待你的确认')
                : status
      }
      onDetails={() => {
        if (selected) setPanel('details');
        else openSessions();
      }}
    />
  );
  return (
    <main
      className={`happier-site unified-shell${navigationOpen ? ' navigation-open' : ''}${view === 'chat' && logged ? ' chat-workspace' : ''}${mode === 'cw' && view === 'chat' && logged ? ' happier-chat-shell' : ''}${mode === 'admin' && admin ? ' admin-workspace' : ''}`}
    >
      <SessionNavigation
        email={emailIdentity.email}
        open={navigationOpen}
        onOpenChange={setNavigationOpen}
        onSettings={() => {
          setMenuOpen(true);
          if (matchMedia('(max-width: 900px)').matches)
            setNavigationOpen(false);
        }}
      >
        {mode === 'cw' && (
          <WorkspaceNavigation
            hosts={hosts}
            projects={projects}
            host={host}
            project={project}
            session={selected?.id}
            sessionTitle={
              threads.find((item) => item.id === selected?.threadId)?.name ||
              selected?.title ||
              (selected ? t('进行中的对话') : undefined)
            }
            locked={fileBusy}
            refreshing={refreshing}
            refresh={() => void refreshView()}
            onHost={(next) => {
              if (next !== host) {
                manualHostSelection.current = next;
                setSelected(undefined);
                setProject('');
                setProjects([]);
                setSessions([]);
                rememberHost(next);
                setHost(next);
              }
              setMenuOpen(false);
            }}
            onProject={(next) => {
              manualHostSelection.current = undefined;
              if (next !== project) {
                setSelected(undefined);
                setProject(next);
              }
              setMenuOpen(false);
            }}
            requestAuthorization={() => setAdding((value) => !value)}
            authorization={
              <>
                {adding && (
                  <section
                    className="navigation-authorization"
                    aria-label={t('申请授权')}
                  >
                    {emailControls}
                    {loginForm}
                    {logged && (
                      <button
                        disabled={!host || fileBusy}
                        onClick={() => {
                          if (
                            confirm(
                              t(
                                '移除此 A 的本地凭证？R 上的授权保持不变，已有任务不会停止。',
                              ),
                            )
                          )
                            void api('/auth/forget', { hostId: host })
                              .then(() => {
                                rememberHost('');
                                forgetEmailHost(host);
                                setHost('');
                                socket.current?.close();
                                setSelected(undefined);
                                return refresh();
                              })
                              .catch(report);
                        }}
                      >
                        {t(
                          emailIdentity.enabled
                            ? '断开当前浏览器连接'
                            : '移除本地授权',
                        )}
                      </button>
                    )}
                  </section>
                )}
                {host && !online && wakeConfigured && (
                  <IconButton
                    icon="power"
                    label={t('重试唤醒')}
                    onClick={() =>
                      void api(`/hosts/${host}/wake`, {})
                        .then(() => setNotice('已请求唤醒，请刷新确认上线状态'))
                        .catch(report)
                    }
                  />
                )}
              </>
            }
            projectAction={
              host && (
                <ProjectManager
                  key={host}
                  operations={operations.current}
                  hostId={host}
                  hostName={
                    hosts.find((item) => item.id === host)?.name || host
                  }
                  changed={refreshView}
                  defaultProjectPath={
                    projects.find((item) => item.id === project)?.path ||
                    projects[0]?.path
                  }
                  creationOnly
                />
              )
            }
          >
            <aside className="session-sidebar unified-session-list">
              <button
                className="new-chat"
                disabled={!online || !host || !project || creating}
                onClick={() => {
                  setMenuOpen(false);
                  if (matchMedia('(max-width: 900px)').matches)
                    setNavigationOpen(false);
                  void create();
                }}
              >
                {t('＋ 新建对话')}
              </button>
              <input
                className="session-search"
                aria-label={t('搜索会话')}
                placeholder={t('搜索已加载的会话…')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <IconButton
                icon="refresh"
                label={loadingThreads ? t('正在加载…') : t('刷新会话')}
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
              />
              <p className="sidebar-caption">
                {t('与远程 Codex 共用历史 · 当前项目')}
              </p>
              <SessionHistory
                compact
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
                  setView('chat');
                  setMenuOpen(false);
                  if (matchMedia('(max-width: 900px)').matches)
                    setNavigationOpen(false);
                }}
                onResume={(threadId) => {
                  setMenuOpen(false);
                  if (matchMedia('(max-width: 900px)').matches)
                    setNavigationOpen(false);
                  void create(threadId);
                }}
              />
              {sessionCursor && (
                <IconButton
                  icon="plus"
                  label={t('加载更多会话记录')}
                  disabled={!online}
                  onClick={() =>
                    void api(
                      `/sessions?paged=true&hostId=${host}&cursor=${encodeURIComponent(sessionCursor)}`,
                    )
                      .then((page) => {
                        setSessions((old) => [
                          ...old,
                          ...page.data.filter(
                            (s: Session) => !old.some((o) => o.id === s.id),
                          ),
                        ]);
                        setSessionCursor(page.nextCursor);
                      })
                      .catch(report)
                  }
                />
              )}
              {cursor && (
                <IconButton
                  icon="plus"
                  label={t('加载更多')}
                  disabled={loadingThreads}
                  onClick={() => void loadThreads(true)}
                />
              )}
            </aside>
          </WorkspaceNavigation>
        )}
        {mode === 'admin' && admin && (
          <nav className="admin-tabs" role="tablist" aria-label={t('管理功能')}>
            {(
              [
                ['pending', t('待授权请求')],
                ['authorized', t('已授权设备')],
                ['versions', t('Agent 运行版本')],
                ['wake', t('服务器唤醒配置')],
                ['emails', t('Agent 邮箱关联')],
                ['projects', t('项目管理')],
                ['keys', t('API Key 管理')],
                ['sessions', t('管理会话')],
                ['misc', t('杂项')],
              ] as const
            ).map(([id, label]) => {
              const selected =
                view === 'keys' ? id === 'keys' : id === adminTab;
              return (
                <button
                  key={id}
                  id={`admin-tab-${id}`}
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`admin-panel-${id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => {
                    setMenuOpen(false);
                    if (matchMedia('(max-width: 900px)').matches)
                      setNavigationOpen(false);
                    if (id === 'keys') setView('keys');
                    else {
                      setAdminTab(id);
                      setView('devices');
                    }
                  }}
                  onKeyDown={(event) => {
                    const tabs = Array.from(
                      event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>(
                        '[role="tab"]',
                      ),
                    );
                    const index = tabs.indexOf(event.currentTarget);
                    const next =
                      event.key === 'ArrowRight'
                        ? (index + 1) % tabs.length
                        : event.key === 'ArrowLeft'
                          ? (index + tabs.length - 1) % tabs.length
                          : event.key === 'Home'
                            ? 0
                            : event.key === 'End'
                              ? tabs.length - 1
                              : -1;
                    if (next < 0) return;
                    event.preventDefault();
                    tabs[next].focus();
                    tabs[next].click();
                  }}
                >
                  <Icon
                    name={
                      (
                        {
                          pending: 'shield',
                          authorized: 'devices',
                          versions: 'activity',
                          wake: 'power',
                          emails: 'mail',
                          projects: 'folder',
                          keys: 'key',
                          sessions: 'chat',
                          misc: 'settings',
                        } as Record<string, IconName>
                      )[id]
                    }
                  />
                  <span>{label}</span>
                </button>
              );
            })}
          </nav>
        )}
      </SessionNavigation>
      {mode === 'admin' && admin && (
        <div className="admin-refresh">
          <IconButton
            icon="refresh"
            label={t('刷新状态')}
            disabled={refreshing}
            onClick={() => void refreshView()}
          />
        </div>
      )}
      <section
        className="unified-settings"
        hidden={!menuOpen}
        aria-label={t('设置')}
        ref={menu}
      >
        <header>
          <IconButton
            showLabel
            icon="back"
            label={t('返回会话')}
            onClick={() => setMenuOpen(false)}
          />
          <h1>{t('设置')}</h1>
        </header>
        <div className="settings-card">
          <h2>{t('外观')}</h2>{' '}
          <div className="menu-footer">
            <label className="language-picker">
              <span className="setting-label">
                <Icon name="theme" />
                {t('主题')}
              </span>
              <select
                aria-label={t('全站主题')}
                value={theme}
                onChange={(event) =>
                  setThemePreference(event.target.value as ThemePreference)
                }
              >
                <option value="system">{t('跟随系统')}</option>
                <option value="light">{t('浅色')}</option>
                <option value="dark">{t('深色')}</option>
              </select>
            </label>
            <label className="language-picker">
              <span className="setting-label">
                <Icon name="language" />
                语言 / Language
              </span>
              <select
                aria-label="语言 / Language"
                value={language}
                onChange={(event) =>
                  setLanguage(event.target.value as Language)
                }
              >
                <option value="zh-CN">中文</option>
                <option value="en">English</option>
              </select>
            </label>
            <IconButton
              showLabel
              icon="devices"
              label={t('切换到{0}模式', mode === 'cw' ? t('管理员') : 'CW')}
              disabled={fileBusy}
              onClick={switchMode}
            />
            <small className="site-version">
              {t('网站版本')} {webVersion}
            </small>
          </div>
          <div ref={setAppearanceTarget} />
        </div>
        <div className="settings-account">
          {mode === 'cw' && emailIdentity.email && (
            <IconButton
              showLabel
              icon="power"
              label={`${t('登出')} ${emailIdentity.email}`}
              onClick={() => window.location.assign('/cdn-cgi/access/logout')}
            />
          )}
          {mode === 'admin' && admin && (
            <IconButton
              showLabel
              icon="power"
              label={t('退出管理')}
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
            />
          )}
        </div>
      </section>
      {logged && view === 'chat' && mode !== 'cw' && workspaceHeader}
      {createOperation && (
        <div className="notice" role="status">
          {t('正在确认')} {remoteTarget} {t('的会话创建结果。请求：')}
          {createOperation.requestId}
          <button
            disabled={creating || !online}
            onClick={() => void create(createOperation.threadId)}
          >
            {t('以原请求继续确认')}
          </button>
          <small>{t('重复使用同一请求身份；不会自动另建任务。')}</small>
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          {t(notice)}
          <IconButton
            icon="close"
            label={t('关闭')}
            onClick={() => setNotice('')}
          />
        </div>
      )}
      {view !== 'chat' && (
        <div className="page-heading">
          <span>
            {
              {
                chat: t('CW 对话'),
                connection: t('登录与授权'),
                devices: t('设备授权'),
                keys: t('API Key 管理'),
              }[view]
            }
          </span>
          <small>
            {mode === 'admin'
              ? t('管理员模式')
              : hosts.find((h) => h.id === host)?.name ||
                t('选择远程主机开始工作')}
          </small>
        </div>
      )}
      {error && (
        <div
          role="alert"
          className={`error${mode === 'cw' ? ' floating-cw-error' : ''}`}
        >
          {t(error)}
          {error.includes('ACCESS_') && (
            <button onClick={() => location.assign('/')}>
              {t('重新验证邮箱')}
            </button>
          )}
          <IconButton
            icon="close"
            label={t('关闭')}
            onClick={() => setError('')}
          />
        </div>
      )}
      {checking && <p role="status">{t('正在检查登录状态…')}</p>}
      {mode === 'admin' && loginForm}
      {!checking && mode === 'cw' && !logged && (
        <section className="card authorization-welcome">
          <h2>{t('连接远程服务器')}</h2>
          <IconButton
            icon="shield"
            label={t('申请授权')}
            onClick={() => {
              setNavigationOpen(true);
              setAdding(true);
            }}
          />
        </section>
      )}
      <ManagerPairing />
      {admin && view === 'devices' && adminTab !== 'misc' && (
        <section
          className="card"
          role="tabpanel"
          id={`admin-panel-${adminTab}`}
          aria-labelledby={`admin-tab-${adminTab}`}
        >
          <h2>
            {t(
              adminTab === 'pending'
                ? '待授权请求'
                : adminTab === 'authorized'
                  ? '已授权设备'
                  : adminTab === 'versions'
                    ? 'Agent 运行版本'
                    : adminTab === 'wake'
                      ? '服务器唤醒配置'
                      : adminTab === 'emails'
                        ? 'Agent 邮箱关联'
                        : adminTab === 'projects'
                          ? '项目管理'
                          : '管理会话',
            )}
          </h2>
          {adminTab === 'versions' && <AgentVersions hosts={keyHosts} />}
          {adminTab === 'pending' && (
            <>
              <p>
                {t(
                  '批准前请与申请方核对配对码和角色；已指定目标的申请不可改绑，其他客户端申请需选择服务器。管理身份不能直接操作 Codex 会话。',
                )}
              </p>
              {managing && (
                <p>
                  {t('当前请求：')}
                  {managing}
                </p>
              )}
              <AdminTable
                label={t('待授权请求')}
                rowValues={devices.pending.map((d) => [
                  d.name,
                  d.role === 'agent'
                    ? t('服务器 Agent')
                    : d.role === 'cli'
                      ? t('命令行客户端')
                      : t('网页客户端'),
                  d.code,
                  d.message || '',
                  keyHosts.find(
                    (h) =>
                      h.id ===
                      (d.requestedHostId || approvalHosts[d.id] || d.hostId),
                  )?.name ||
                    d.requestedHostId ||
                    approvalHosts[d.id] ||
                    d.hostId ||
                    '',
                  d.expires,
                  t('批准') + d.code,
                ])}
                columns={[
                  '设备名称',
                  '角色',
                  '配对码',
                  '留言',
                  '目标服务器',
                  '有效期',
                  '操作',
                ].map((label) => t(label))}
                empty={!devices.pending.length}
                emptyText={t('暂无待授权请求')}
              >
                {devices.pending.map((d) => (
                  <tr
                    className={
                      d.id === managing ? 'highlight-request' : undefined
                    }
                    id={`request-${d.id}`}
                    key={d.id}
                  >
                    <th scope="row">
                      {d.name}
                      {d.email && (
                        <p>
                          {t('已验证邮箱：')}
                          {d.email}
                        </p>
                      )}
                      <details>
                        <summary>{t('请求标识')}</summary>
                        <p className="id">{d.id}</p>
                      </details>
                    </th>
                    <td>
                      {d.role === 'agent'
                        ? t('服务器 Agent')
                        : d.role === 'cli'
                          ? t('命令行客户端')
                          : t('网页客户端')}
                    </td>
                    <td>
                      <code>{d.code}</code>
                    </td>
                    <td>
                      <p className="request-message" tabIndex={0}>
                        {d.message || t('未填写')}
                      </p>
                    </td>
                    <td>
                      {d.role !== 'agent' ? (
                        <>
                          <select
                            aria-label={t('目标服务器 {0}', d.code)}
                            value={
                              d.requestedHostId || approvalHosts[d.id] || ''
                            }
                            disabled={!!d.requestedHostId}
                            onChange={(e) =>
                              setApprovalHosts((current) => ({
                                ...current,
                                [d.id]: e.target.value,
                              }))
                            }
                          >
                            <option value="">{t('请选择服务器')}</option>
                            {keyHosts.map((h) => (
                              <option key={h.id} value={h.id}>
                                {h.name} · {h.id}
                              </option>
                            ))}
                          </select>
                          {d.requestedHostId && (
                            <p className="id">
                              {t('申请方指定：')}
                              {d.requestedHostId}
                              {t('；该 Agent 也可批准或拒绝。')}
                            </p>
                          )}
                          {!keyHosts.length && (
                            <p>
                              {t('暂无可授权的服务器，请先授权服务器 Agent。')}
                            </p>
                          )}
                        </>
                      ) : (
                        keyHosts.find((host) => host.id === d.hostId)?.name ||
                        d.hostId
                      )}
                    </td>
                    <td>
                      <time dateTime={new Date(d.expires).toISOString()}>
                        {new Date(d.expires).toLocaleString(localeTag())}
                      </time>
                    </td>
                    <td>
                      <div className="admin-table-actions">
                        <button
                          disabled={
                            generating ||
                            (d.role !== 'agent' &&
                              !keyHosts.some(
                                (h) =>
                                  h.id ===
                                  (d.requestedHostId || approvalHosts[d.id]),
                              ))
                          }
                          onClick={() => {
                            if (d.manager) {
                              location.hash = 'manager=' + d.id;
                              location.reload();
                            } else void manage('approve', d.id);
                          }}
                        >
                          {d.manager ? t('确认管理身份') : t('批准')} {d.code}
                        </button>
                        <button
                          disabled={generating}
                          onClick={() => void manage('reject', d.id)}
                        >
                          {t('拒绝')} {d.code}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </AdminTable>
            </>
          )}
          {adminTab === 'projects' &&
            keyHosts.map((h) => (
              <section className="card" key={h.id}>
                <AgentAdminEmail host={h} saved={readAdminSnapshot} />
                <ProjectManager hostId={h.id} hostName={h.name} admin />
              </section>
            ))}
          {adminTab === 'authorized' && (
            <AuthorizedDevices
              credentials={devices.credentials}
              hosts={keyHosts}
              busy={generating}
              revoke={(id) => void manage('revoke', id)}
            />
          )}
          {adminTab === 'emails' && (
            <>
              <p>
                {t(
                  '关联邮箱通过验证后，所有 CW 浏览器自动获得该 Agent 的访问权，无需配对。管理员配置优先；清空可禁用关联，恢复则沿用 Agent 配置。移除关联会断开仅由该关联授权的 CW，独立配对授权保留。',
                )}
              </p>
              <AdminTable
                label={t('Agent 邮箱关联')}
                columns={['服务器', '配置来源', '关联邮箱'].map((label) =>
                  t(label),
                )}
                rowValues={keyHosts.map((h) => [
                  h.name,
                  h.accessEmailsOverride === undefined
                    ? t('使用 Agent 配置')
                    : t('使用管理员配置'),
                  (h.accessEmailsOverride ?? h.agentAccessEmails ?? []).join(
                    ', ',
                  ),
                ])}
                empty={!keyHosts.length}
                emptyText={t('暂无可授权的服务器，请先授权服务器 Agent。')}
              >
                {keyHosts.map((h) => (
                  <HostEmailSettings
                    key={h.id}
                    host={h}
                    saved={readAdminSnapshot}
                    report={report}
                  />
                ))}
              </AdminTable>
            </>
          )}
          {adminTab === 'wake' && (
            <>
              <AdminTable
                label={t('服务器唤醒配置')}
                rowValues={keyHosts.map((h) => [
                  h.name,
                  h.wakeUrlOverride === undefined
                    ? t('使用 Agent 配置')
                    : h.wakeUrlOverride
                      ? t('使用管理员配置')
                      : t('管理员已禁用唤醒'),
                  h.wakeUrlOverride ?? h.agentWakeUrl ?? '',
                  t('保存唤醒配置'),
                ])}
                columns={['服务器', '配置来源', '唤醒 URL', '操作'].map(
                  (label) => t(label),
                )}
                empty={!keyHosts.length}
                emptyText={t('暂无服务器')}
              >
                {keyHosts.map((h) => (
                  <HostWakeSettings
                    key={h.id}
                    host={h}
                    report={report}
                    saved={async () => {
                      await readAdminSnapshot();
                      setNotice('唤醒配置已保存');
                      await refresh();
                    }}
                  />
                ))}
              </AdminTable>
            </>
          )}
          {adminTab === 'sessions' && (
            <>
              <button
                onClick={() => {
                  if (
                    confirm(
                      t('撤销其他浏览器的管理员登录？设备与客户端授权保留。'),
                    )
                  )
                    void api('/auth/logout-others', {})
                      .then(() => setNotice('其他管理会话已撤销'))
                      .catch(report);
                }}
              >
                {t('退出其他管理会话')}
              </button>
            </>
          )}
        </section>
      )}
      {mode === 'admin' && admin && (
        <section
          className="card"
          role="tabpanel"
          id="admin-panel-misc"
          aria-labelledby="admin-tab-misc"
          hidden={view !== 'devices' || adminTab !== 'misc'}
        >
          <h2>{t('杂项')}</h2>
          <AgentUpdates />
          <RemoteConfiguration hosts={keyHosts} />
        </section>
      )}
      {admin && view === 'keys' && (
        <section
          className="card"
          role="tabpanel"
          id="admin-panel-keys"
          aria-labelledby="admin-tab-keys"
        >
          <h2>{t('API Key 管理')}</h2>
          <p>
            {t(
              'Key 本身就是长期访问凭证，直到从 R 撤销。角色与目标 A 不可修改；请妥善保管。',
            )}
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
                  await readAdminSnapshot();
                })
                .catch(report)
                .finally(() => setGenerating(false));
            }}
          >
            <label>
              {t('Key 名称')}
              <input
                aria-label={t('Key 名称')}
                required
                maxLength={100}
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
              />
            </label>
            <label>
              {t('使用程序')}
              <select
                aria-label={t('使用程序')}
                value={keyRole}
                onChange={(e) => setKeyRole(e.target.value)}
              >
                <option value="agent">coc-agent</option>
                <option value="cli">coc-client</option>
              </select>
            </label>
            {keyRole === 'cli' ? (
              <label>
                {t('目标 A')}
                <select
                  aria-label={t('Key 目标 A')}
                  required
                  value={keyHost}
                  onChange={(e) => setKeyHost(e.target.value)}
                >
                  <option value="">{t('请选择 A')}</option>
                  {keyHosts.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name} · {h.id}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p>{t('A Key 在首次登录时创建并永久绑定自己的 A。')}</p>
            )}
            <button disabled={generating}>{t('生成 API_KEY')}</button>
          </form>
          {newKey && (
            <div className="card">
              <p>{t('仅显示这一次，请保存：')}</p>
              <input aria-label={t('新 API_KEY')} readOnly value={newKey} />
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
                {t('复制 API_KEY')}
              </button>
              <IconButton
                icon="close"
                label={t('隐藏 API_KEY')}
                onClick={() => setNewKey('')}
              />
            </div>
          )}
          <AdminTable
            label={t('API Key 管理')}
            rowValues={apiKeys.map((k) => [
              k.name,
              k.role === 'agent' ? 'coc-agent' : 'coc-client',
              keyHosts.find((h) => h.id === k.hostId)?.name || k.hostId || '',
              k.created,
              t('撤销') + k.name,
            ])}
            columns={[
              'Key 名称',
              '使用程序',
              '目标服务器',
              '创建时间',
              '操作',
            ].map((label) => t(label))}
            empty={!apiKeys.length}
            emptyText={t('暂无 API Key')}
          >
            {apiKeys.map((k) => (
              <tr key={k.id}>
                <th scope="row">{k.name}</th>
                <td>{k.role === 'agent' ? 'coc-agent' : 'coc-client'}</td>
                <td>
                  {keyHosts.find((host) => host.id === k.hostId)?.name ||
                    k.hostId ||
                    t('等待首次使用绑定')}
                </td>
                <td>
                  <time dateTime={new Date(k.created).toISOString()}>
                    {new Date(k.created).toLocaleString(localeTag())}
                  </time>
                  <small>{t('长期有效')}</small>
                </td>
                <td>
                  <button
                    disabled={generating}
                    onClick={() => {
                      if (
                        !confirm(
                          k.role === 'agent' && k.hostId
                            ? t(
                                '撤销此 A Key 将停用 A，并撤销其全部客户端授权。继续？',
                              )
                            : t('撤销此 API Key？'),
                        )
                      )
                        return;
                      setGenerating(true);
                      void api('/admin/api-keys/revoke', { id: k.id })
                        .then(async () => {
                          setNewKey('');
                          await readAdminSnapshot();
                        })
                        .catch(report)
                        .finally(() => setGenerating(false));
                    }}
                  >
                    {t('撤销 Key')} {k.name}
                  </button>
                </td>
              </tr>
            ))}
          </AdminTable>
        </section>
      )}
      {logged && view === 'chat' && (
        <>
          {view === 'chat' && (
            <Workbench
              menuTarget={workbenchMenuTarget}
              closeMenu={() => setPanel(null)}
              appearanceTarget={appearanceTarget}
              refresh={() => void refreshView()}
              refreshing={refreshing}
              information={
                panel === 'details' && selected ? (
                  <section className="session-details">
                    <div className="session-details-content">
                      <p className="status">
                        {t(status)}
                        {selected.external
                          ? t(' · 外部会话 · 只读同步')
                          : ''} · {busy ? t('执行中') : t('空闲')}{' '}
                        {t('· 远程项目')} {selected.projectId}
                      </p>
                      <p>{remoteTarget}</p>
                      <p>{projects.find((p) => p.id === project)?.path}</p>
                      <details>
                        <summary>{t('会话标识')}</summary>
                        <p className="id">{selected.id}</p>
                      </details>
                      <details>
                        <summary>{t('本机存储')}</summary>
                        <p>
                          {t(
                            '清理仅删除本设备历史副本，保留草稿与待确认请求；远程历史保留。未重新缓存前无法离线读取。',
                          )}
                        </p>
                        <IconButton
                          icon="trash"
                          label={t('清理本机会话缓存')}
                          onClick={() => {
                            if (
                              confirm(
                                t(
                                  '清理此设备的会话缓存？离线时将无法读取这些副本。',
                                ),
                              )
                            )
                              void localHistory.current
                                ?.clear()
                                .then(() => setNotice('本机会话缓存已清理'))
                                .catch(report);
                          }}
                        />
                      </details>
                    </div>
                    <footer className="session-detail-actions">
                      {((['closed', 'failed'].includes(selected.state) &&
                        selected.threadId) ||
                        (selected.state === 'ready' &&
                          !ready &&
                          !projectReadOnly)) && (
                        <IconButton
                          icon={
                            controlElsewhere
                              ? 'chat'
                              : selected.state === 'ready'
                                ? 'refresh'
                                : 'history'
                          }
                          label={t(
                            controlElsewhere || selected.state !== 'ready'
                              ? '继续对话'
                              : '重试连接',
                          )}
                          disabled={!online || creating}
                          onClick={continueConversation}
                        />
                      )}

                      <IconButton
                        icon="stop"
                        label={t('停止本轮')}
                        disabled={
                          !ready || !online || !busy || selected.external
                        }
                        onClick={() => send({ action: 'interrupt' })}
                      />
                      <IconButton
                        icon="power"
                        label={t('结束会话')}
                        onClick={() => {
                          if (
                            confirm(
                              selected.external
                                ? t('断开此只读连接？原客户端继续运行。')
                                : t('结束会话？已修改文件不会回滚。'),
                            )
                          )
                            void endSession(selected)
                              .then((closed: Session) => {
                                setSessions((v) =>
                                  v.map((s) =>
                                    s.id === closed.id ? closed : s,
                                  ),
                                );
                                setClosingSession(
                                  closed.state === 'closed'
                                    ? undefined
                                    : closed.id,
                                );
                                setSelected(undefined);
                                setPanel(null);
                                setStatus(
                                  closed.state === 'closed'
                                    ? '会话已结束'
                                    : '正在结束会话',
                                );
                              })
                              .catch(report);
                        }}
                      />
                    </footer>
                  </section>
                ) : panel === 'details' ? (
                  <section className="session-details">
                    {workspaceHeader}
                    <p>{projects.find((p) => p.id === project)?.path}</p>
                  </section>
                ) : undefined
              }
              openInformation={() =>
                setPanel(panel === 'details' ? null : 'details')
              }
              host={host}
              project={project}
              root={projects.find((item) => item.id === project)?.path || ''}
              activity={{
                busy,
                ready: ready && online,
                approvals: approvals.map((item) => item.approvalId),
              }}
              terminal={{
                control: terminalControl,
                operations: operations.current,
                enabled:
                  !!selected &&
                  ready &&
                  online &&
                  !projectReadOnly &&
                  !busy &&
                  !selected.external,
              }}
              session={selected?.id}
              events={events}
              chunks={contentChunks}
              reading={readingContent}
              read={readContent}
              transfer={(visible) => (
                <WorkspaceFiles
                  key={JSON.stringify([host, project])}
                  visible={visible}
                  operations={operations.current}
                  host={host}
                  project={project}
                  target={remoteTarget}
                  onBusy={setFileBusy}
                  cache={catalog.current}
                />
              )}
              reference={(path) =>
                setText((current) => `${current}${current ? '\n' : ''}${path}`)
              }
            >
              <div
                className={`chat-layout${mode === 'cw' ? ' happier-cw' : ''}`}
              >
                <dialog
                  className="chat-panel"
                  ref={panelDialog}
                  aria-labelledby="chat-panel-title"
                  onClose={() => setPanel(null)}
                  onCancel={(event) => {
                    event.preventDefault();
                    closePanel();
                  }}
                >
                  <div className="panel-heading">
                    <h2 id="chat-panel-title">{t('选择模型')}</h2>
                    <IconButton
                      icon="close"
                      label={t('关闭面板')}
                      onClick={closePanel}
                    />
                  </div>
                  {panel === 'models' && (
                    <ModelPicker
                      load={loadModels}
                      current={selectedModel}
                      disabled={
                        busy ||
                        pending ||
                        !!unconfirmed ||
                        !!promptProgress ||
                        !ready ||
                        !online
                      }
                      onChoose={async (model) => {
                        const cache = localHistory.current;
                        if (!cache) throw new Error(t('本机存储尚未就绪'));
                        await cache.record('model', model);
                        if (localHistory.current !== cache) return;
                        setSelectedModel(model);
                        setPanel(null);
                      }}
                    />
                  )}
                </dialog>
                <section className="conversation" aria-label={t('Codex 对话')}>
                  {mode === 'cw' && (
                    <SessionHeading
                      notice={
                        !error &&
                        host &&
                        (!online ||
                          (selected?.state === 'ready' &&
                            !ready &&
                            !projectReadOnly)) ? (
                          <div className="connection-notice" role="status">
                            <Icon name="activity" />
                            <span>
                              {!online
                                ? t('服务器离线 · 只读缓存')
                                : controlElsewhere
                                  ? t('此会话正在其他页面使用。')
                                  : t('连接中…')}
                            </span>
                            <IconButton
                              icon="refresh"
                              label={t(
                                controlElsewhere ? '继续对话' : '重试连接',
                              )}
                              onClick={() => {
                                if (selected && online) continueConversation();
                                else void refreshView();
                              }}
                            />
                            <IconButton
                              icon="info"
                              label={t('信息')}
                              onClick={() => setPanel('details')}
                            />
                          </div>
                        ) : undefined
                      }
                      actions={
                        <div
                          className="workspace-toolbar"
                          ref={setWorkbenchMenuTarget}
                        />
                      }
                    />
                  )}

                  {selected ? (
                    <>
                      <div
                        className="messages"
                        ref={messageList}
                        role="log"
                        aria-label={t('对话消息')}
                        aria-live="off"
                        tabIndex={0}
                        onTouchStart={bottomRefresh.onTouchStart}
                        onTouchMove={bottomRefresh.onTouchMove}
                        onTouchEnd={bottomRefresh.onTouchEnd}
                        onTouchCancel={bottomRefresh.onTouchCancel}
                        onKeyDown={bottomRefresh.onKeyDown}
                        onWheel={(e) => {
                          bottomRefresh.onWheel(e);
                          if (
                            e.deltaY < 0 &&
                            e.currentTarget.scrollTop <= 0 &&
                            hasOlder &&
                            !loadingHistory
                          )
                            loadHistory.current(olderCursor);
                        }}
                        onScroll={(e) => {
                          bottomRefresh.onScroll(e);
                          const el = e.currentTarget;
                          const scrolledUp =
                            el.scrollTop < messageScrollTop.current;
                          messageScrollTop.current = el.scrollTop;
                          followMessages.current =
                            !olderView.current &&
                            el.scrollHeight - el.scrollTop - el.clientHeight <
                              80;
                          setAway(!followMessages.current);
                          if (
                            scrolledUp &&
                            !followMessages.current &&
                            el.scrollTop < 160 &&
                            hasOlder &&
                            !loadingHistory
                          )
                            loadHistory.current(olderCursor);
                        }}
                      >
                        {olderView.current && (
                          <p className="status">
                            {t(
                              '正在浏览较早内容 · 已加载的消息全部保留，优先读取本地历史。',
                            )}
                          </p>
                        )}
                        <div className="row">
                          {hasOlder && (
                            <button
                              aria-label={t('加载更早内容')}
                              disabled={loadingHistory}
                              onClick={() => loadHistory.current(olderCursor)}
                            >
                              {loadingHistory
                                ? t('正在加载更早内容…')
                                : t('加载更早内容')}
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
                              {t('返回最新内容')}
                            </button>
                          )}
                        </div>
                        {historyNotice && (
                          <p role="status">{t(historyNotice)}</p>
                        )}
                        <FileContext.Provider value={fileContext}>
                          <ConversationView
                            events={events}
                            chunks={contentChunks}
                            reading={readingContent}
                            onRead={readContent}
                          />
                        </FileContext.Provider>
                        {(busy || promptProgress) && (
                          <p className="thinking" role="status">
                            ●{' '}
                            {!ready
                              ? t('连接已断开，等待重新连接确认状态…')
                              : promptProgress === 'sending'
                                ? t('正在发送给 Codex…')
                                : approvals.length
                                  ? t('等待你的确认')
                                  : promptProgress === 'replying'
                                    ? t('Codex 正在回复…')
                                    : selected.external
                                      ? t('Codex 正在处理…')
                                      : t('已发送，等待 Codex 回复…')}
                          </p>
                        )}
                        {!events.length &&
                          !unconfirmed &&
                          !promptProgress &&
                          !busy && (
                            <p className="empty-hint">
                              {t('对话已就绪，发送任务开始。')}
                            </p>
                          )}
                      </div>
                      <ApprovalQueue
                        approvals={approvals}
                        events={events}
                        target={`${hosts.find((h) => h.id === host)?.name || host} / ${projects.find((p) => p.id === project)?.name || project}`}
                        ready={
                          ready &&
                          online &&
                          (!selected.external || !!selected.approvalForwarding)
                        }
                        pending={pending}
                        onAnswer={(approvalId, allow) => {
                          const approval = approvals.find(
                            (item) => item.approvalId === approvalId,
                          );
                          if (!approval) return;
                          send({
                            action: 'approval',
                            approvalId,
                            allow,
                            runtimeId: approval.runtimeId,
                            approvalVersion: approval.approvalVersion,
                          });
                        }}
                      />
                      {unconfirmed && (
                        <div className="submission-state" role="status">
                          <strong>
                            {pending && promptProgress === 'sending'
                              ? t('正在发送给 Codex…')
                              : t('任务提交结果待确认')}
                          </strong>
                          <p>{unconfirmed.text}</p>
                          <button
                            onClick={() => {
                              if (controlElsewhere) continueConversation();
                              else {
                                setTakeover(false);
                                setReconnect((value) => value + 1);
                              }
                            }}
                          >
                            {t('重试连接并核对结果')}
                          </button>
                          <small>
                            {t('请求')} {unconfirmed.requestId}
                            {t('；请先核对远程历史，避免重复执行。')}
                          </small>
                        </div>
                      )}
                      {!selected.external && (
                        <PromptQueue
                          queue={selected.promptQueue ?? []}
                          enabled={
                            ready &&
                            online &&
                            !pending &&
                            selected.state === 'ready' &&
                            !projectReadOnly
                          }
                          onRun={(queueId) =>
                            send({ action: 'queueRun', queueId })
                          }
                          onCancel={(queueId) =>
                            send({ action: 'queueCancel', queueId })
                          }
                        />
                      )}
                      {projectReadOnly ? (
                        <div className="readonly-hint" role="status">
                          <p>{t('只读会话 · 同项目已有写会话')}</p>
                          <p>
                            {t(
                              '可查看历史；请先关闭当前写连接，再获取写权限。',
                            )}
                          </p>
                          <button
                            onClick={() => {
                              setTakeover(false);
                              setReconnect((n) => n + 1);
                            }}
                          >
                            {t('获取写权限')}
                          </button>
                        </div>
                      ) : controlElsewhere ? (
                        <div className="readonly-hint" role="status">
                          <p>{t('此会话正在其他页面使用。')}</p>
                          <button
                            disabled={!online}
                            onClick={continueConversation}
                          >
                            {t('继续对话')}
                          </button>
                        </div>
                      ) : selected.state !== 'ready' ? (
                        <div className="readonly-hint" role="status">
                          <p>
                            {t(
                              selected.state === 'starting'
                                ? '会话启动中，请稍候。'
                                : selected.state === 'closing'
                                  ? '会话正在结束，请稍候。'
                                  : selected.state === 'failed'
                                    ? '会话运行中断，可沿用历史继续对话。'
                                    : '当前为历史记录，可沿用原对话继续。',
                            )}
                          </p>
                          {['closed', 'failed'].includes(selected.state) &&
                            selected.threadId && (
                              <button
                                disabled={!online || creating}
                                onClick={continueConversation}
                              >
                                {t('继续对话')}
                              </button>
                            )}
                        </div>
                      ) : (
                        <form
                          className="composer"
                          onSubmit={(e) => {
                            e.preventDefault();
                            if (text.trim() === '/model') {
                              openModels();
                              if (!selected.external) {
                                setText('');
                                void localHistory.current
                                  ?.saveDraft('')
                                  .catch(report);
                              }
                              return;
                            }
                            if (
                              text.trim() &&
                              ready &&
                              !pending &&
                              (selected.external || busy || !promptProgress) &&
                              (!selected.external || selected.queueEnabled) &&
                              !pendingCommand.current
                            ) {
                              send({
                                action:
                                  !selected.external &&
                                  (busy || selected.promptQueue?.length)
                                    ? 'enqueue'
                                    : 'prompt',
                                text,
                                ...(!selected.external && selectedModel
                                  ? { model: selectedModel }
                                  : {}),
                              });
                            }
                          }}
                        >
                          <label>
                            <span className="composer-label">
                              {t('任务内容')}
                            </span>
                            <textarea
                              aria-label={t('任务内容')}
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
                                  ?.saveDraft(e.target.value)
                                  .catch(report);
                              }}
                              maxLength={64000}
                              title={t('Enter 发送，Shift + Enter 换行')}
                              disabled={
                                selected.external && !selected.queueEnabled
                              }
                              placeholder={
                                selected.external
                                  ? t('加入原客户端队列…')
                                  : busy
                                    ? t('输入消息，当前轮结束后自动执行…')
                                    : t('发送消息给 Codex…')
                              }
                            />
                          </label>
                          <button
                            type="button"
                            className="model-toggle"
                            onClick={openModels}
                          >
                            <Icon name="activity" size={15} />
                            <span>{selectedModel || t('选择模型')}</span>
                          </button>
                          {busy && !selected.external && (
                            <button
                              type="button"
                              disabled={!ready || !online || pending}
                              onClick={() => send({ action: 'interrupt' })}
                            >
                              {t('停止本轮')}
                            </button>
                          )}
                          {
                            <button
                              type="submit"
                              className="composer-send"
                              aria-label={
                                selected.external
                                  ? t('加入队列')
                                  : busy || selected.promptQueue?.length
                                    ? t('排队消息')
                                    : t('发送')
                              }
                              title={
                                selected.external
                                  ? t('加入队列')
                                  : busy || selected.promptQueue?.length
                                    ? t('排队消息')
                                    : t('发送')
                              }
                              disabled={
                                !ready ||
                                !online ||
                                pending ||
                                !!unconfirmed ||
                                (!selected.external &&
                                  !busy &&
                                  !!promptProgress) ||
                                (selected.external && !selected.queueEnabled) ||
                                !text.trim()
                              }
                            >
                              {selected.external
                                ? t('加入队列')
                                : busy || selected.promptQueue?.length
                                  ? t('排队消息')
                                  : t('发送')}
                            </button>
                          }
                          <AutoApproval
                            key={`${host}:${selected.id}`}
                            enabled={selected.autoApproval}
                            ready={
                              ready &&
                              online &&
                              (!selected.external ||
                                !!selected.approvalForwarding ||
                                selected.autoApproval === true)
                            }
                            onChange={setAutoApproval}
                          />
                          <small
                            className={
                              selected.external
                                ? 'composer-external-help'
                                : 'composer-help'
                            }
                          >
                            {selected.external &&
                              (selected.queueEnabled
                                ? selected.approvalForwarding
                                  ? t(
                                      '外部会话：已入队不代表已执行；可在此审批命令与文件操作，执行沿用原客户端策略。 ',
                                    )
                                  : t(
                                      '外部会话：已入队不代表已执行；当前审批仍需原客户端处理。 ',
                                    )
                                : t(
                                    '只读同步；Agent 配置 externalSessions.allowQueue=true 且使用 workspace-write 后可加入队列。 ',
                                  ))}
                            {matchMedia('(pointer: coarse)').matches
                              ? t('Enter 换行，点击发送提交')
                              : t('Enter 发送 · Shift+Enter 换行')}
                            {text.length > 60000
                              ? t(' · 剩余 {0} 字符', 64000 - text.length)
                              : ''}
                          </small>
                          {!ready && <small role="status">{t(status)}</small>}
                        </form>
                      )}
                    </>
                  ) : (
                    <div className="chat-welcome">
                      <div className="welcome-icon">
                        <CodexMark />
                      </div>
                      <h2>{t('今天要一起完成什么？')}</h2>
                      <p>
                        {t('恢复 Codex 本地会话，或在远程项目中开始新对话。')}
                      </p>
                      <IconButton
                        icon="chat"
                        label={t('打开左侧导航')}
                        onClick={openSessions}
                      />
                    </div>
                  )}
                </section>
              </div>
            </Workbench>
          )}
        </>
      )}
      {view !== 'chat' && (
        <footer>
          {t('文件和命令在远程服务器执行。关闭页面不会立即停止任务。')}
        </footer>
      )}
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <SiteTheme>
    {new URLSearchParams(location.hash.slice(1)).get('preview') === 'file' ? (
      <FilePreview />
    ) : (
      <App />
    )}
  </SiteTheme>,
);

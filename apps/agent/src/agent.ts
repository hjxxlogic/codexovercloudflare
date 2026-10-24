import WebSocket from 'ws';
import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  AppError,
  errorData,
  MAX_FRAME,
  MAX_QUEUE,
  parseFrame,
  webCommandSchema,
  wsUrl,
  type AgentConfig,
  type Rpc,
  type Session,
} from '../../../packages/protocol/src/index.ts';
import { CodexProcess, guardCli, redact } from './codex.ts';
import { Store } from './store.ts';

type Runtime = {
  process: CodexProcess;
  epoch: number;
  detachedAt: number | null;
  approvals: Map<string, { rpc: Rpc; time: number }>;
  cliRequests: Map<string, string>;
  cliSubmitted: boolean;
  queue: Promise<void>;
};
export class Agent {
  store: Store;
  runtimes = new Map<string, Runtime>();
  socket?: WebSocket;
  stopped = false;
  retry?: ReturnType<typeof setTimeout>;
  maintenance?: ReturnType<typeof setInterval>;
  attempts = 0;
  lastPong = Date.now();
  constructor(public config: AgentConfig) {
    const ids = new Set<string>();
    config.projects = config.projects.map((p) => {
      if (ids.has(p.id)) throw new Error('Duplicate project ID');
      ids.add(p.id);
      const path = realpathSync(resolve(p.path));
      if (!statSync(path).isDirectory())
        throw new Error('Project must be a directory');
      return { ...p, path };
    });
    config.dataDir = resolve(config.dataDir);
    this.store = new Store(config.dataDir);
  }
  start() {
    this.connect();
    this.maintenance = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        if (Date.now() - this.lastPong > 90000) this.socket.terminate();
        else this.send({ type: 'ping' });
      }
      for (const [id, rt] of this.runtimes) {
        for (const [key, a] of rt.approvals)
          if (Date.now() - a.time > 600000) {
            this.answerApproval(id, key, false);
          }
        if (rt.detachedAt && Date.now() - rt.detachedAt > 1800000)
          this.stopSession(id);
      }
      try {
        this.store.cleanup();
      } catch {
        for (const s of this.runtimes.keys()) this.stopSession(s);
      }
    }, 30000);
  }
  connect() {
    if (this.stopped) return;
    const ws = new WebSocket(wsUrl(this.config.relayUrl, '/ws/v1/agent'), {
      headers: { Authorization: 'Bearer ' + this.config.token },
      maxPayload: MAX_FRAME,
    });
    this.socket = ws;
    ws.on('open', () => {
      this.lastPong = Date.now();
      console.log('Agent connected');
    });
    ws.on('message', (raw) => {
      try {
        const d = parseFrame(raw.toString());
        if (d.type === 'hello') {
          this.attempts = 0;
          return;
        }
        if (d.type === 'pong') {
          this.lastPong = Date.now();
          return;
        }
        if (d.type === 'control') {
          void this.control(d.action, d.data)
            .then((data) =>
              this.send({ type: 'result', requestId: d.requestId, data }),
            )
            .catch((e) =>
              this.send({
                type: 'result',
                requestId: d.requestId,
                error: errorData(e),
              }),
            );
          return;
        }
        const rt = this.runtimes.get(d.sessionId);
        if (!rt || rt.epoch !== d.epoch) return;
        if (d.type === 'detach') {
          rt.detachedAt = Date.now();
          return;
        }
        if (d.type === 'rpc') {
          this.cli(d.sessionId, d.payload);
          return;
        }
        if (d.type === 'web') {
          rt.queue = rt.queue
            .then(async () => {
              if (rt.epoch === d.epoch) await this.web(d.sessionId, d.payload);
            })
            .catch((e) =>
              this.notice(d.sessionId, {
                type: 'error',
                requestId: d.payload?.requestId,
                error: errorData(e),
              }),
            );
        }
      } catch {
        ws.close(4000, 'Invalid relay message');
      }
    });
    ws.on('error', () => {});
    ws.on('close', (code) => {
      for (const rt of this.runtimes.values())
        if (!rt.detachedAt) rt.detachedAt = Date.now();
      if (code === 4001) {
        console.error(
          'Device authorization revoked or expired; stopping Agent',
        );
        void this.close();
        return;
      }
      if (!this.stopped) {
        const delay =
          Math.min(30000, 1000 * 2 ** Math.min(5, this.attempts++)) *
          (0.8 + Math.random() * 0.4);
        this.retry = setTimeout(() => this.connect(), delay);
      }
    });
  }
  send(data: unknown) {
    const ws = this.socket;
    if (ws?.readyState !== WebSocket.OPEN) return;
    const text = JSON.stringify(data);
    if (Buffer.byteLength(text) > MAX_FRAME || ws.bufferedAmount > MAX_QUEUE) {
      ws.close(1013, 'Queue limit');
      return;
    }
    ws.send(text);
  }
  notice(id: string, payload: unknown) {
    const rt = this.runtimes.get(id);
    if (rt)
      this.send({ type: 'notice', sessionId: id, epoch: rt.epoch, payload });
  }
  emit(id: string, type: string, data: unknown) {
    const e = this.store.event(id, type, data);
    const rt = this.runtimes.get(id);
    if (rt)
      this.send({
        type: 'event',
        sessionId: id,
        epoch: rt.epoch,
        payload: { type: 'event', event: e },
      });
  }
  project(id: string) {
    const p = this.config.projects.find((p) => p.id === id);
    if (!p)
      throw new AppError('PROJECT_NOT_FOUND', 'Project not registered', 404);
    if (realpathSync(p.path) !== p.path)
      throw new AppError('PATH_CHANGED', 'Project real path changed');
    return p;
  }
  async control(action: string, d: any) {
    if (action === 'projects')
      return this.config.projects.map(({ id, name, path }) => ({
        id,
        name,
        path,
      }));
    if (action === 'list') return this.store.sessions();
    if (action === 'get') return this.store.get(d.sessionId);
    if (action === 'stop') {
      this.stopSession(d.sessionId);
      return this.store.get(d.sessionId);
    }
    if (action === 'attach') {
      const s = this.store.get(d.sessionId),
        rt = this.runtimes.get(s.id);
      if (!rt || s.state !== 'ready')
        throw new AppError('SESSION_CLOSED', 'Session is not running');
      if (s.mode === 'cli' && rt.epoch > 0)
        throw new AppError(
          'CLI_REATTACH_UNSUPPORTED',
          'This version cannot safely reinitialize an existing CLI runtime; end this session and create a new one',
        );
      rt.epoch = d.epoch;
      rt.detachedAt = null;
      return { ok: true };
    }
    if (action === 'create') {
      const key = 'create:' + d.key,
        fingerprint = JSON.stringify({ projectId: d.projectId, mode: d.mode }),
        cached = this.store.begin(key, fingerprint);
      if (cached.cached) return cached.value;
      this.project(d.projectId);
      if (this.runtimes.size >= 4)
        throw new AppError('CAPACITY', 'At most four active sessions', 409);
      const s: Session = {
        id: this.config.hostId + '~' + randomUUID(),
        projectId: d.projectId,
        mode: d.mode,
        sandbox: this.config.sandbox,
        state: 'ready',
        running: false,
        createdAt: Date.now(),
      };
      this.store.save(s);
      const process = new CodexProcess(
        this.config.codexPath,
        this.config.codexArgs,
        this.project(s.projectId).path,
        this.config.sandbox,
        (msg) => this.onCodex(s.id, msg),
        () => this.onExit(s.id),
      );
      const rt: Runtime = {
        process,
        epoch: 0,
        detachedAt: Date.now(),
        approvals: new Map(),
        cliRequests: new Map(),
        cliSubmitted: false,
        queue: Promise.resolve(),
      };
      this.runtimes.set(s.id, rt);
      try {
        if (s.mode === 'web') {
          await process.initialize();
          const result = await process.request('thread/start', {
            cwd: this.project(s.projectId).path,
            sandbox: this.config.sandbox,
            approvalPolicy: 'on-request',
          });
          s.threadId = result.thread.id;
          this.store.save(s);
        }
        this.store.finish(key, s);
        return s;
      } catch (e) {
        this.stopSession(s.id);
        throw e;
      }
    }
    throw new AppError('UNSUPPORTED_ACTION', 'Unknown control action');
  }
  checkProjectBusy(s: Session) {
    if (
      this.store
        .sessions()
        .some(
          (other) =>
            other.id !== s.id &&
            other.projectId === s.projectId &&
            other.state === 'ready' &&
            other.running,
        )
    )
      throw new AppError(
        'PROJECT_BUSY',
        'Another session is executing in this project',
        409,
      );
  }
  cli(id: string, msg: Rpc) {
    const s = this.store.get(id),
      rt = this.runtimes.get(id)!;
    try {
      if (!msg || typeof msg !== 'object')
        throw new AppError('INVALID_REQUEST', 'Invalid RPC');
      if (!msg.method) {
        const approval = rt.approvals.get(String(msg.id));
        if (!approval)
          throw new AppError('UNKNOWN_APPROVAL', 'No matching server request');
        rt.approvals.delete(String(msg.id));
        rt.process.send(msg);
        return;
      }
      const guarded = guardCli(
        msg,
        this.project(s.projectId).path,
        this.config.sandbox,
        s.threadId,
      );
      if (msg.method === 'thread/start' && rt.cliSubmitted)
        throw new AppError('UNSUPPORTED_ACTION', 'One thread per CLI session');
      if (['thread/list', 'thread/loaded/list'].includes(msg.method)) {
        this.send({
          type: 'rpc',
          sessionId: id,
          epoch: rt.epoch,
          payload: {
            id: msg.id,
            result:
              msg.method === 'thread/list'
                ? { data: [], nextCursor: null }
                : { data: s.threadId ? [s.threadId] : [] },
          },
        });
        return;
      }
      if (['turn/start', 'turn/steer'].includes(msg.method)) {
        rt.cliSubmitted = true;
        this.checkProjectBusy(s);
        s.running = true;
        this.store.save(s);
      }
      if (msg.id !== undefined) rt.cliRequests.set(String(msg.id), msg.method);
      rt.process.send(guarded);
    } catch (e) {
      this.send({
        type: 'rpc',
        sessionId: id,
        epoch: rt.epoch,
        payload: {
          id: msg?.id ?? null,
          error: { code: -32001, message: errorData(e).message },
        },
      });
    }
  }
  onCodex(id: string, msg: Rpc) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const s = this.store.get(id);
    if (s.mode === 'cli' && msg.id !== undefined && !msg.method) {
      const method = rt.cliRequests.get(String(msg.id));
      rt.cliRequests.delete(String(msg.id));
      if (method === 'thread/start' && msg.result?.thread) {
        s.threadId = msg.result.thread.id;
        this.store.save(s);
      }
      if (msg.error && ['turn/start', 'turn/steer'].includes(method || '')) {
        s.running = false;
        this.store.save(s);
      }
    }
    if (msg.method === 'turn/started') {
      s.running = true;
      s.turnId = msg.params?.turn?.id;
      this.store.save(s);
    }
    if (msg.method === 'turn/completed') {
      s.running = false;
      s.turnId = undefined;
      this.store.save(s);
    }
    if (msg.method && msg.id !== undefined) {
      const key = String(msg.id);
      const supported = [
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
        'item/tool/requestUserInput',
        'mcpServer/elicitation/request',
      ];
      if (!supported.includes(msg.method)) {
        rt.process.send({
          id: msg.id,
          error: {
            code: -32601,
            message: 'Remote client does not support this request',
          },
        });
        return;
      }
      rt.approvals.set(key, { rpc: msg, time: Date.now() });
      if (s.mode === 'web') {
        if (
          ![
            'item/commandExecution/requestApproval',
            'item/fileChange/requestApproval',
          ].includes(msg.method)
        ) {
          rt.process.send({
            id: msg.id,
            error: {
              code: -32601,
              message:
                'This web version supports command and file approvals only',
            },
          });
          rt.approvals.delete(key);
          this.emit(id, 'warning', {
            message:
              'Unsupported interactive request was rejected: ' + msg.method,
          });
          return;
        }
        this.emit(id, 'approval', {
          approvalId: key,
          method: msg.method,
          params: msg.params,
        });
        return;
      }
    }
    if (s.mode === 'cli')
      this.send({
        type: 'rpc',
        sessionId: id,
        epoch: rt.epoch,
        payload: redact(msg),
      });
    else if (msg.method) this.emit(id, msg.method, msg.params || {});
  }
  async web(id: string, raw: unknown) {
    const cmd = webCommandSchema.parse(raw),
      s = this.store.get(id),
      rt = this.runtimes.get(id)!;
    if (cmd.action === 'sync') {
      const replay = this.store.replay(id, cmd.after);
      this.notice(id, {
        type: 'sync',
        session: s,
        ...replay,
        approvals: Array.from(rt.approvals, ([approvalId, a]) => ({
          approvalId,
          method: a.rpc.method,
          params: a.rpc.params,
        })),
      });
      return;
    }
    const key = id + ':' + cmd.requestId,
      cached = this.store.begin(key, JSON.stringify(cmd));
    if (cached.cached) {
      this.notice(id, {
        type: 'ack',
        requestId: cmd.requestId,
        result: cached.value,
      });
      return;
    }
    let result: unknown;
    if (cmd.action === 'prompt') {
      if (s.running)
        throw new AppError('TURN_BUSY', 'A turn is already running', 409);
      this.checkProjectBusy(s);
      s.running = true;
      this.store.save(s);
      this.emit(id, 'user', { text: cmd.text });
      try {
        const r = await rt.process.request('turn/start', {
          threadId: s.threadId,
          input: [{ type: 'text', text: cmd.text, text_elements: [] }],
        });
        const current = this.store.get(id);
        if (current.running) current.turnId = r.turn.id;
        this.store.save(current);
        result = { turnId: r.turn.id };
      } catch (e) {
        if (!(e instanceof AppError && e.code === 'RESULT_UNKNOWN')) {
          const current = this.store.get(id);
          current.running = false;
          this.store.save(current);
        }
        throw e;
      }
    } else if (cmd.action === 'interrupt') {
      result = s.turnId
        ? await rt.process.request('turn/interrupt', {
            threadId: s.threadId,
            turnId: s.turnId,
          })
        : { ok: true };
    } else {
      this.answerApproval(id, cmd.approvalId, cmd.allow);
      result = { ok: true };
    }
    this.store.finish(key, result);
    this.notice(id, { type: 'ack', requestId: cmd.requestId, result });
  }
  answerApproval(id: string, key: string, allow: boolean) {
    const rt = this.runtimes.get(id)!,
      a = rt.approvals.get(key);
    if (!a)
      throw new AppError(
        'UNKNOWN_APPROVAL',
        'Approval expired or already answered',
      );
    if (
      ![
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
      ].includes(a.rpc.method!)
    ) {
      rt.process.send({
        id: a.rpc.id,
        error: { code: -32000, message: 'Approval timed out' },
      });
    } else
      rt.process.send({
        id: a.rpc.id,
        result: { decision: allow ? 'accept' : 'decline' },
      });
    rt.approvals.delete(key);
    this.emit(id, 'approvalResolved', { approvalId: key, allow });
  }
  onExit(id: string) {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    const s = this.store.get(id);
    if (s.state !== 'closed') s.state = 'failed';
    s.running = false;
    this.store.save(s);
    this.emit(id, 'sessionClosed', { state: s.state });
    this.runtimes.delete(id);
  }
  stopSession(id: string) {
    const s = this.store.get(id),
      rt = this.runtimes.get(id);
    s.state = 'closed';
    s.running = false;
    this.store.save(s);
    if (rt) {
      if (s.turnId)
        void rt.process
          .request('turn/interrupt', { threadId: s.threadId, turnId: s.turnId })
          .catch(() => {});
      rt.process.close();
    }
  }
  async close() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this.retry);
    clearInterval(this.maintenance);
    this.socket?.close();
    for (const id of this.runtimes.keys()) this.stopSession(id);
    const until = Date.now() + 4000;
    while (this.runtimes.size && Date.now() < until)
      await new Promise((r) => setTimeout(r, 25));
    this.store.close();
  }
}

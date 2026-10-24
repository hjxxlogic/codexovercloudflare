import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  AppError,
  MAX_FRAME,
  MAX_QUEUE,
  parseFrame,
  type Rpc,
} from '../../../packages/protocol/src/index.ts';

export class CodexProcess {
  child: ChildProcessWithoutNullStreams;
  pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  nextId = 0;
  exited = false;
  constructor(
    command: string,
    args: string[],
    cwd: string,
    sandbox: string,
    private onMessage: (msg: Rpc) => void,
    private onExit: () => void,
  ) {
    this.child = spawn(
      command,
      [
        ...args,
        'app-server',
        '--listen',
        'stdio://',
        '-c',
        `sandbox_mode="${sandbox}"`,
        '-c',
        'approval_policy="on-request"',
      ],
      { cwd, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // Do not log stderr: it can contain local paths, account data, or prompt content.
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.close());
    const lines = createInterface({ input: this.child.stdout });
    this.child.stdout.on('data', () => {
      if (this.child.stdout.readableLength > MAX_QUEUE) this.close();
    });
    let partialBytes = 0;
    this.child.stdout.on('data', (chunk: Buffer) => {
      partialBytes += chunk.length;
      if (partialBytes > MAX_QUEUE) this.close();
      if (chunk.includes(10)) partialBytes = 0;
    });
    lines.on('line', (line) => {
      try {
        if (Buffer.byteLength(line) > MAX_FRAME - 4096)
          throw new AppError(
            'MESSAGE_TOO_LARGE',
            'Codex output exceeds frame limit',
          );
        const msg: Rpc = parseFrame(line);
        if (
          typeof msg.id === 'number' &&
          !msg.method &&
          this.pending.has(msg.id)
        ) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error)
            p.reject(new AppError('CODEX_ERROR', msg.error.message));
          else p.resolve(msg.result);
        } else this.onMessage(msg);
      } catch {
        this.close();
      }
    });
    const exit = () => {
      if (this.exited) return;
      this.exited = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new AppError('CODEX_EXITED', 'Codex process exited'));
      }
      this.pending.clear();
      this.onExit();
    };
    this.child.on('error', exit);
    this.child.on('exit', exit);
  }
  send(msg: Rpc) {
    const data = JSON.stringify(msg) + '\n';
    if (this.exited) throw new AppError('CODEX_EXITED', 'Codex exited');
    if (
      Buffer.byteLength(data) > MAX_FRAME ||
      this.child.stdin.writableLength > MAX_QUEUE
    )
      throw new AppError('BACKPRESSURE', 'Codex input limit reached');
    this.child.stdin.write(data);
  }
  request(method: string, params: any): Promise<any> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new AppError('RESULT_UNKNOWN', 'Codex response timed out'));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  async initialize() {
    const r = await this.request('initialize', {
      clientInfo: { name: 'coc-web', version: '0.1.0' },
      capabilities: { experimentalApi: false },
    });
    this.send({ method: 'initialized' });
    return r;
  }
  close() {
    if (!this.exited) {
      this.child.kill('SIGTERM');
      const timer = setTimeout(() => {
        if (!this.exited) this.child.kill('SIGKILL');
      }, 3000);
      timer.unref();
    }
  }
}

const CLI_METHODS = new Set([
  'initialize',
  'initialized',
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/list',
  'thread/loaded/list',
  'thread/turns/list',
  'thread/items/list',
  'thread/unsubscribe',
  'thread/name/set',
  'turn/start',
  'turn/steer',
  'turn/interrupt',
  'model/list',
  'account/read',
  'account/rateLimits/read',
  'config/read',
  'configRequirements/read',
  'permissionProfile/list',
  'skills/list',
  'mcpServerStatus/list',
  'plugin/list',
  'plugin/installed',
  'app/list',
  'app/installed',
  'experimentalFeature/list',
  'hooks/list',
  'account/bedrock/checkGovCloudRequirements',
  'collaborationMode/list',
]);
export function guardCli(
  msg: Rpc,
  cwd: string,
  sandbox: string,
  threadId?: string,
): Rpc {
  if (!msg.method) return msg;
  if (!CLI_METHODS.has(msg.method))
    throw new AppError(
      'UNSUPPORTED_METHOD',
      `Remote CLI does not support ${msg.method}`,
    );
  const p = structuredClone(msg.params || {});
  if (p.threadId && p.threadId !== threadId)
    throw new AppError('FORBIDDEN', 'Thread does not belong to this session');
  if (msg.method === 'thread/resume' && !threadId)
    throw new AppError(
      'FORBIDDEN',
      'Cross-session history resume is not supported yet',
    );
  if (['thread/start', 'thread/resume', 'turn/start'].includes(msg.method)) {
    if (p.cwd && p.cwd !== cwd)
      throw new AppError(
        'FORBIDDEN',
        'Changing remote working directory is not allowed',
      );
    // Native TUI echoes materialized local settings on subsequent thread starts.
    // Keep the server configuration authoritative; never apply this override.
    delete p.config;
    if (p.approvalsReviewer === 'user') delete p.approvalsReviewer;
    if (p.sandboxPolicy) {
      const expected = sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite';
      if (
        p.sandboxPolicy.type === expected &&
        p.sandboxPolicy.networkAccess !== true &&
        (!p.sandboxPolicy.writableRoots ||
          p.sandboxPolicy.writableRoots.every((root: string) => root === cwd))
      )
        delete p.sandboxPolicy;
    }
    for (const field of [
      'config',
      'baseInstructions',
      'developerInstructions',
      'sandboxPolicy',
      'approvalsReviewer',
    ])
      if (p[field] != null)
        throw new AppError(
          'FORBIDDEN',
          `Remote override ${field} is not allowed`,
        );
    if (p.sandbox && p.sandbox !== sandbox)
      throw new AppError('FORBIDDEN', 'Sandbox escalation rejected');
    if (p.approvalPolicy && p.approvalPolicy !== 'on-request')
      throw new AppError('FORBIDDEN', 'Approval policy override rejected');
    p.cwd = cwd;
    p.approvalPolicy = 'on-request';
    if (msg.method !== 'turn/start') p.sandbox = sandbox;
  }
  if (Array.isArray(p.input) && p.input.some((x: any) => x.type !== 'text'))
    throw new AppError(
      'UNSUPPORTED_INPUT',
      'Only text input is supported remotely',
    );
  if (['thread/start', 'thread/resume'].includes(msg.method)) {
    const allowed = [
      'threadId',
      'cwd',
      'sandbox',
      'approvalPolicy',
      'model',
      'modelProvider',
      'serviceTier',
      'ephemeral',
    ];
    return {
      ...msg,
      params: Object.fromEntries(
        allowed.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]),
      ),
    };
  }
  if (msg.method === 'turn/start') {
    const allowed = [
      'threadId',
      'input',
      'cwd',
      'approvalPolicy',
      'model',
      'effort',
      'summary',
      'serviceTier',
    ];
    return {
      ...msg,
      params: Object.fromEntries(
        allowed.filter((k) => p[k] !== undefined).map((k) => [k, p[k]]),
      ),
    };
  }
  return { ...msg, params: p };
}
export function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        k === 'env'
          ? {}
          : /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|authorization)$/i.test(
                k,
              ) && typeof v === 'string'
            ? '[redacted]'
            : redact(v),
      ]),
    );
  return value;
}

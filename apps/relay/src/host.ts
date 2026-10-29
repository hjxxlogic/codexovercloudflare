import { DurableObject } from 'cloudflare:workers';
import { dueEntries, expireAt, migrateExpiry, nextExpiry } from './expiry.ts';
import {
  AppError,
  idSchema,
  MAX_QUEUE,
  MAX_FRAME,
  historyCommandSchema,
  webCommandSchema,
  agentBuildSchema,
  controlCommandSchema,
  parseFrame,
  wakeUrlSchema,
} from '../../../packages/protocol/src/index.ts';
import {
  body,
  digest,
  failure,
  json,
  registryCall as callRegistry,
  token,
  type Auth,
  type Env,
} from './common.ts';

const registryCall = (env: Env, op: string, data: unknown = {}) =>
  callRegistry(env, op, data, 'host');

type Attachment = {
  id?: string;
  subscription?: boolean;
  receipts?: { sent: number; acked: number; seq: number; ack: number };
  role: 'agent' | 'web' | 'cli';
  auth: Auth;
  hostId: string;
  sessionId?: string;
  epoch: number;
  authenticated: boolean;
  history?: boolean;
  historyEvents?: boolean;
  deadline: number;
  build?: unknown;
  protocol?: number;
};
type Ticket = {
  sessionId: string;
  mode: 'web' | 'cli';
  hash: string;
  expires: number;
  takeover: boolean;
  epoch?: number;
};
type Lease = {
  epoch: number;
  active: boolean;
  expires?: number;
  pending?: { epoch: number; id: string; expires: number };
};
type Operation = {
  id: string;
  auth: Auth;
  hostId: string;
  kind: 'control' | 'ticket' | 'history-open' | 'history' | 'attach';
  data: any;
  action: string;
  stage: 'get' | 'execute' | 'attach';
  socketId?: string;
  clientRequestId?: string;
  info?: any;
  reservation?: { epoch: number; id: string; expires: number };
  wire?: string;
  agentEpoch?: number;
  expires: number;
  state: 'pending' | 'completed';
  result?: any;
  error?: { code: string; message: string; status?: number };
};
export class HostRelayDO extends DurableObject<Env> {
  private authorization = new Map<
    string,
    { expires: number; checked: number }
  >();
  private authorizing = new Map<
    string,
    { promise: Promise<void>; token: object }
  >();
  private authorizationVersion = 0;
  private authMetrics = { hits: 0, misses: 0, coalesced: 0 };
  private incomingBytes = 0;
  private forwardingBytes = 0;
  private forwards = new WeakMap<
    WebSocket,
    { tail: Promise<void>; bytes: number; count: number }
  >();
  private forward(client: WebSocket, payload: unknown, bytes: number) {
    let queue = this.forwards.get(client);
    if (!queue) {
      queue = { tail: Promise.resolve(), bytes: 0, count: 0 };
      this.forwards.set(client, queue);
    }
    if (
      queue.bytes + bytes > MAX_QUEUE ||
      queue.count >= 1000 ||
      this.forwardingBytes + bytes > MAX_QUEUE * 2
    ) {
      client.close(4008, 'Forwarding budget exhausted');
      return;
    }
    queue.bytes += bytes;
    queue.count++;
    this.forwardingBytes += bytes;
    const current = queue.tail
      .then(async () => {
        const attachment = client.deserializeAttachment() as Attachment;
        if (client.readyState >= 2) return;
        if (attachment.deadline <= Date.now()) throw new Error('expired');
        await this.authorized(attachment.auth.hash);
        if (client.readyState < 2 || client.readyState === undefined)
          this.send(client, payload);
      })
      .catch(() => {
        client.close(4001, 'Authorization or forwarding failed');
      })
      .finally(() => {
        queue!.bytes -= bytes;
        queue!.count--;
        this.forwardingBytes -= bytes;
        if (queue!.tail === current) this.forwards.delete(client);
      });
    queue.tail = current;
    this.ctx.waitUntil(current);
  }
  async authorized(hash: string) {
    const cached = this.authorization.get(hash);
    if (
      cached &&
      cached.checked + 5000 > Date.now() &&
      cached.expires > Date.now()
    ) {
      this.authMetrics.hits++;
      return;
    }
    const active = this.authorizing.get(hash);
    if (active) {
      this.authMetrics.coalesced++;
      return active.promise;
    }
    this.authMetrics.misses++;
    const version = this.authorizationVersion;
    const token = {};
    const check = (async () => {
      const auth: Auth = await registryCall(this.env, 'authHash', { hash });
      if (
        version !== this.authorizationVersion ||
        this.authorizing.get(hash)?.token !== token
      )
        throw new AppError(
          'UNAUTHORIZED',
          'Authorization changed during validation',
          401,
        );
      if (this.authorization.size >= 128)
        this.authorization.delete(this.authorization.keys().next().value!);
      this.authorization.set(hash, {
        expires: auth.expires,
        checked: Date.now(),
      });
    })();
    this.authorizing.set(hash, { promise: check, token });
    try {
      await check;
    } finally {
      if (this.authorizing.get(hash)?.promise === check)
        this.authorizing.delete(hash);
    }
  }
  private messages = new WeakMap<
    WebSocket,
    { tail: Promise<void>; bytes: number }
  >();
  agent() {
    return this.ctx.getWebSockets('agent').find((s) => s.readyState === 1);
  }
  send(ws: WebSocket, data: unknown) {
    const attachment = ws.deserializeAttachment() as Attachment | undefined;
    const receipts =
      attachment?.history ||
      (attachment?.role === 'web' && attachment.authenticated);
    const counter = attachment?.receipts || {
      sent: 0,
      acked: 0,
      seq: 0,
      ack: 0,
    };
    const receiptId = receipts
      ? `${counter.seq + 1}:${counter.sent}`
      : undefined;
    const value =
      typeof data === 'string'
        ? data
        : JSON.stringify({
            ...(data as object),
            ...(receiptId ? { receiptId } : {}),
          });
    const bytes = new TextEncoder().encode(value).length;
    if (bytes > MAX_FRAME)
      throw new AppError('MESSAGE_TOO_LARGE', 'Outgoing frame too large', 413);
    if (receiptId) {
      const total = this.ctx.getWebSockets().reduce((sum, socket) => {
        const r = (socket.deserializeAttachment() as Attachment)?.receipts;
        return sum + (r ? r.sent - r.acked : 0);
      }, 0);
      if (
        counter.sent - counter.acked + bytes > MAX_QUEUE ||
        total + bytes > MAX_QUEUE * 2 ||
        counter.seq - counter.ack >= 1000
      ) {
        ws.close(4008, 'Reader acknowledgement budget exhausted');
        return;
      }
      counter.seq++;
      counter.sent += bytes;
      attachment!.receipts = counter;
      ws.serializeAttachment(attachment);
    }
    ws.send(value);
  }

  private async saveOperation(o: Operation) {
    const encoded = JSON.stringify(o);
    const previous = await this.ctx.storage.get<{ parts?: number }>(
      'operation:' + o.id,
    );
    const parts = Math.max(
      previous?.parts || 0,
      Math.ceil(encoded.length / 16000),
    );
    const records: Record<string, unknown> = {};
    for (let i = 0; i < parts; i++)
      records[`part:${o.id}:${i}`] = encoded.slice(i * 16000, (i + 1) * 16000);
    records['operation:' + o.id] = {
      id: o.id,
      state: o.state,
      auth: o.auth,
      expires: o.expires,
      wire: o.wire,
      socketId: o.socketId,
      kind: o.kind,
      action: o.action,
      parts,
    };
    await this.ctx.storage.put(records);
  }
  private async loadOperation(id: string): Promise<Operation | undefined> {
    const index = await this.ctx.storage.get<Operation & { parts?: number }>(
      'operation:' + id,
    );
    if (!index || !index.parts) return index;
    const parts = await Promise.all(
      Array.from({ length: index.parts }, (_, i) =>
        this.ctx.storage.get<string>(`part:${id}:${i}`),
      ),
    );
    if (parts.some((part) => part === undefined))
      throw new AppError('RESULT_UNKNOWN', 'Incomplete operation receipt', 409);
    return JSON.parse(parts.join(''));
  }
  private async deleteOperation(id: string) {
    const index = await this.ctx.storage.get<{ parts?: number; wire?: string }>(
      'operation:' + id,
    );
    await this.ctx.storage.delete([
      'operation:' + id,
      ...(index?.wire ? ['wire:' + index.wire] : []),
      ...Array.from({ length: index?.parts || 0 }, (_, i) => `part:${id}:${i}`),
    ]);
  }
  private socket(id?: string) {
    return this.ctx
      .getWebSockets()
      .find((ws) => (ws.deserializeAttachment() as Attachment).id === id);
  }
  private async changed(scope = 'host', owner?: string, operationId?: string) {
    // Notifications have no replay payload; future subscribers read a fresh
    // snapshot. Do not materialize unused host storage for an unobserved change.
    if (!this.ctx.getWebSockets().length) return;
    const revision =
      ((await this.ctx.storage.get<number>('revision')) || 0) + 1;
    await this.ctx.storage.put('revision', revision);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (a.subscription && (!owner || a.auth.hash === owner))
        this.forward(ws, { type: 'change', scope, revision, operationId }, 200);
    }
  }
  async command(action: string, data: any, operation: Operation) {
    data = controlCommandSchema.parse({ action, data }).data;
    const ws = this.agent();
    if (!ws) throw new AppError('HOST_OFFLINE', 'Host is offline', 503);
    const agent = ws.deserializeAttachment() as Attachment;
    if (agent.protocol !== 1)
      throw new AppError(
        'AGENT_NEGOTIATING',
        'Upgrade Agent and complete negotiation',
        503,
      );
    await this.authorized(agent.auth.hash);
    if (agent.epoch !== (await this.ctx.storage.get('agentEpoch')))
      throw new AppError('STALE_AGENT', 'Agent replaced', 409);
    const requestId = crypto.randomUUID();
    operation.wire = requestId;
    operation.agentEpoch = agent.epoch;
    await this.saveOperation(operation);
    await this.ctx.storage.put('wire:' + requestId, operation.id);
    this.send(ws, { v: 1, type: 'control', requestId, action, data });
    console.log(
      JSON.stringify({
        event: 'control_accepted',
        action,
        requestId,
        kind: operation.kind,
      }),
    );
  }
  private async start(input: Omit<Operation, 'id' | 'expires' | 'state'>) {
    const operation: Operation = {
      ...input,
      id: crypto.randomUUID(),
      expires: Date.now() + 300000,
      state: 'pending',
    };
    const existing = await this.ctx.storage.transaction(async (tx) => {
      const pending = await tx.list<Operation>({
        prefix: 'operation:',
        limit: 257,
      });
      if (input.action === 'probe') {
        const previous = [...pending.values()].find(
          (o) =>
            o.action === 'probe' &&
            o.auth.hash === input.auth.hash &&
            o.state === 'pending' &&
            o.expires > Date.now(),
        );
        if (previous) return previous;
      }
      if (
        [...pending.values()].filter((o) => o.state === 'pending').length >=
          64 ||
        pending.size >= 256
      )
        throw new AppError(
          'BACKPRESSURE',
          'Host control request budget exhausted',
          429,
        );
      if (
        input.socketId &&
        [...pending.values()].some(
          (o) =>
            o.socketId === input.socketId &&
            o.state === 'pending' &&
            o.kind === 'attach',
        )
      )
        throw new AppError('SESSION_BUSY', 'Attach already pending', 409);
      await tx.put('operation:' + operation.id, { ...operation, data: {} });
    });
    if (existing) return existing;
    await expireAt(
      this.ctx.storage,
      'operation:' + operation.id,
      operation.expires,
    );
    try {
      await this.command(
        operation.stage === 'get' ? 'get' : operation.action,
        operation.stage === 'get'
          ? { sessionId: operation.data.sessionId }
          : operation.data,
        operation,
      );
    } catch (error) {
      await this.complete(operation, undefined, error);
    }
    return operation;
  }
  private async complete(o: Operation, result?: any, error?: unknown) {
    if (o.wire) await this.ctx.storage.delete('wire:' + o.wire);
    o.state = 'completed';
    if (error)
      o.error =
        error instanceof AppError
          ? { code: error.code, message: error.message, status: error.status }
          : {
              code: 'RESULT_UNKNOWN',
              message:
                'Request result unknown; refresh using its original identity',
            };
    else o.result = result;
    const ws = this.socket(o.socketId);
    if (o.socketId) {
      await this.deleteOperation(o.id);
      if (!ws) return;
      const a = ws.deserializeAttachment() as Attachment;
      await this.authorized(a.auth.hash);
      if (o.error) {
        this.send(ws, {
          type: 'error',
          requestId: o.clientRequestId,
          error: o.error,
        });
        if (o.kind !== 'history') ws.close(4000, 'Request rejected');
      } else if (o.kind === 'history')
        this.send(ws, {
          type: 'history',
          requestId: o.clientRequestId,
          ...result,
        });
      else if (o.kind === 'history-open') {
        a.authenticated = true;
        a.deadline = a.auth.expires;
        ws.serializeAttachment(a);
        this.send(ws, { type: 'history-ready' });
      } else {
        a.epoch = o.reservation!.epoch;
        a.authenticated = true;
        a.deadline = a.auth.expires;
        ws.serializeAttachment(a);
        this.send(ws, { type: 'attached', epoch: a.epoch });
      }
    } else {
      await this.saveOperation(o);
      await this.changed('operation', o.auth.hash, o.id);
      if (o.action === 'create')
        await this.changed('request-results', o.auth.hash);
      if (['create', 'stop'].includes(o.action)) await this.changed('sessions');
    }
  }
  private async result(o: Operation, data: any, error?: any) {
    if (error)
      return this.complete(
        o,
        undefined,
        new AppError(error.code, error.message, agentErrorStatus(error.code)),
      );
    await this.authorized(o.auth.hash);
    if (o.stage === 'get') {
      if (data.mode !== o.auth.role)
        return this.complete(
          o,
          undefined,
          new AppError('FORBIDDEN', 'Wrong credential for session mode', 403),
        );
      o.info = data;
      if (o.kind === 'history-open') return this.complete(o, {});
      if (o.kind === 'ticket') {
        if (data.state !== 'ready')
          return this.complete(
            o,
            undefined,
            new AppError('SESSION_CLOSED', 'Session is not active', 409),
          );
        if (data.mode === 'cli' && data.canReattach === false)
          return this.complete(
            o,
            undefined,
            new AppError(
              'CLI_REATTACH_UNSUPPORTED',
              'Create a new CLI session',
              409,
            ),
          );
        if (data.mode === 'web') return this.issueTicket(o);
      }
      if (o.kind === 'attach' || (o.kind === 'ticket' && data.mode === 'cli')) {
        o.stage = 'attach';
        o.reservation = await this.reserve(o.data.sessionId, o.data.takeover);
        return this.command(
          'attach',
          {
            sessionId: o.data.sessionId,
            epoch: o.reservation.epoch,
            expires: o.reservation.expires,
          },
          o,
        );
      }
      o.stage = 'execute';
      return this.command(o.action, o.data, o);
    }
    if (o.stage === 'attach') {
      await this.ctx.storage.transaction(async (tx) => {
        const key = 'lease:' + o.data.sessionId,
          lease = await tx.get<Lease>(key);
        if (
          lease?.pending?.id !== o.reservation!.id ||
          o.reservation!.expires <= Date.now()
        )
          throw new AppError(
            'STALE_CONTROLLER',
            'Attach reservation expired or replaced',
            409,
          );
        await tx.put(key, {
          epoch: o.reservation!.epoch,
          active: true,
          ...(o.kind === 'ticket' ? { expires: o.reservation!.expires } : {}),
        } satisfies Lease);
      });
      for (const ws of this.ctx.getWebSockets('session:' + o.data.sessionId)) {
        const a = ws.deserializeAttachment() as Attachment;
        if (a.authenticated && !a.history && a.id !== o.socketId)
          ws.close(4009, 'Control taken over');
      }
      if (o.kind === 'ticket') return this.issueTicket(o);
    }
    return this.complete(o, data);
  }
  private async issueTicket(o: Operation) {
    const active = this.ctx
      .getWebSockets('session:' + o.data.sessionId)
      .some((ws) => {
        const a = ws.deserializeAttachment() as Attachment;
        return a.authenticated && !a.history;
      });
    if (active && !o.data.takeover)
      return this.complete(
        o,
        undefined,
        new AppError('SESSION_BUSY', 'Use explicit takeover', 409),
      );
    const value = token(),
      key = 'ticket:' + (await digest(value)),
      expires = Math.min(
        Date.now() + 60000,
        o.reservation?.expires ?? Number.MAX_SAFE_INTEGER,
      );
    await this.ctx.storage.put(key, {
      sessionId: o.data.sessionId,
      mode: o.info.mode,
      hash: o.auth.hash,
      expires,
      takeover: o.data.takeover === true,
      ...(o.reservation ? { epoch: o.reservation.epoch } : {}),
    } satisfies Ticket);
    await expireAt(this.ctx.storage, key, expires);
    await this.complete(o, {
      ticket: value,
      mode: o.info.mode,
      sandbox: o.info.sandbox,
      expiresIn: Math.max(1, Math.floor((expires - Date.now()) / 1000)),
    });
  }
  async fetch(req: Request) {
    try {
      const u = new URL(req.url),
        s = this.ctx.storage;
      await migrateExpiry(s, ['ticket:']);
      if (u.pathname === '/notify') {
        const d = await body(req);
        if (d.scope === 'requests' || d.scope === 'release') {
          const ws = this.agent();
          if (ws) {
            const a = ws.deserializeAttachment() as Attachment;
            await this.authorized(a.auth.hash);
            this.send(ws, {
              type: 'change',
              scope: d.scope,
              revision: d.revision,
              ...(d.version ? { version: d.version } : {}),
            });
          }
        }
        await this.changed(d.scope);
        return json({ ok: true });
      }
      if (u.pathname === '/wake') {
        const host = await registryCall(this.env, 'host', {
          id: req.headers.get('x-host'),
        });
        const agent = this.agent();
        if (
          agent &&
          (agent.deserializeAttachment() as Attachment).protocol === 1
        )
          return json({ state: 'online' });
        const url = wakeUrlSchema.parse(
          host.wakeUrlOverride ?? host.agentWakeUrl ?? '',
        );
        if (!url) return json({ state: 'unconfigured' });
        const retryAfterMs = await s.transaction(async (tx) => {
          const until = (await tx.get<number>('wakeUntil')) || 0;
          if (until > Date.now()) return until - Date.now();
          await tx.put('wakeUntil', Date.now() + 60000);
          return 0;
        });
        if (retryAfterMs) return json({ state: 'cooldown', retryAfterMs });
        try {
          const response = await fetch(url, {
            method: 'GET',
            redirect: 'manual',
            signal: AbortSignal.timeout(10000),
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error('Wake endpoint failed');
        } catch {
          throw new AppError(
            'WAKE_FAILED',
            'Wake endpoint failed; retry after one minute',
            502,
          );
        }
        return json({ state: 'requested', retryAfterMs: 60000 });
      }
      if (u.pathname === '/status') {
        const agent = this.agent();
        const a = agent?.deserializeAttachment() as Attachment | undefined;
        if (agent && a) {
          try {
            await this.authorized(a.auth.hash);
          } catch {
            agent.close(4001, 'Authorization revoked');
            return json({ online: false, confirmed: false });
          }
        }
        return json({
          confirmed: false,
          reachability: agent ? 'unconfirmed' : 'offline',
          online: !!agent && a?.protocol === 1,
          build: a?.build,
          protocol: a?.protocol,
        });
      }
      if (u.pathname === '/revoke-auth') {
        const d = await body(req);
        if (d.agent) {
          this.authorizationVersion++;
          this.authorization.clear();
          this.authorizing.clear();
        } else {
          this.authorization.delete(d.hash);
          this.authorizing.delete(d.hash);
        }
        for (const ws of this.ctx.getWebSockets())
          if (
            d.agent ||
            (ws.deserializeAttachment() as Attachment).auth.hash === d.hash
          )
            ws.close(4001, 'Device revoked');
        return json({ ok: true });
      }
      const auth: Auth = JSON.parse(
        decodeURIComponent(req.headers.get('x-auth') || '%7B%7D'),
      );
      const hostId = req.headers.get('x-host')!;
      if (u.pathname === '/agent')
        return await this.upgrade(req, {
          role: 'agent',
          auth,
          hostId,
          epoch: ((await s.get<number>('agentEpoch')) || 0) + 1,
          authenticated: true,
          deadline: auth.expires,
        });
      if (u.pathname === '/subscribe')
        return this.upgrade(req, {
          role: auth.role as 'web' | 'cli',
          auth,
          hostId,
          epoch: 0,
          authenticated: true,
          subscription: true,
          deadline: auth.expires,
        });
      if (u.pathname.startsWith('/operation/')) {
        const o = await this.loadOperation(
          idSchema.parse(u.pathname.slice('/operation/'.length)),
        );
        if (!o || o.auth.hash !== auth.hash)
          throw new AppError('NOT_FOUND', 'Unknown operation', 404);
        if (o.expires <= Date.now())
          throw new AppError(
            'RESULT_UNKNOWN',
            'Result receipt expired; query original request identity',
            409,
          );
        if (req.method === 'POST') {
          if (o.state === 'completed') await this.deleteOperation(o.id);
          return json({ ok: true });
        }
        return json({ state: o.state, result: o.result, error: o.error });
      }
      if (u.pathname === '/control' || u.pathname === '/ticket') {
        if (req.headers.get('x-coc-async') !== '1')
          throw new AppError(
            'UPGRADE_REQUIRED',
            'Upgrade client for asynchronous results',
            409,
          );
        const d = await body(req),
          ticket = u.pathname === '/ticket';
        const o = await this.start({
          auth,
          hostId,
          kind: ticket ? 'ticket' : 'control',
          action: ticket ? 'get' : d.action,
          data: ticket ? d : d.data,
          stage:
            ticket ||
            ['stop', 'queue', 'approvals', 'answer'].includes(d.action)
              ? 'get'
              : 'execute',
        });
        return json({ accepted: true, operationId: o.id, hostId }, 202);
      }
      if (u.pathname === '/cli') {
        const sessionId = u.searchParams.get('sessionId')!,
          t = await this.consume(
            req.headers.get('x-ticket') || '',
            sessionId,
            'cli',
          );
        const a: Auth = await registryCall(this.env, 'authHash', {
          hash: t.hash,
        });
        if (a.role !== 'cli' || a.hostId !== hostId || !t.epoch)
          throw new AppError(
            'FORBIDDEN',
            'Upgrade CLI and obtain a current ticket',
            403,
          );
        const lease = await s.get<Lease>('lease:' + sessionId);
        if (lease?.epoch !== t.epoch)
          throw new AppError('STALE_CONTROLLER', 'Ticket superseded', 409);
        const response = await this.upgrade(req, {
          role: 'cli',
          auth: a,
          hostId,
          sessionId,
          epoch: t.epoch,
          authenticated: true,
          deadline: a.expires,
        });
        await s.transaction(async (tx) => {
          const current = await tx.get<Lease>('lease:' + sessionId);
          if (current?.epoch === t.epoch)
            await tx.put('lease:' + sessionId, {
              epoch: t.epoch,
              active: true,
            });
        });
        return response;
      }
      if (u.pathname === '/history') {
        return this.upgrade(req, {
          role: auth.role as 'web' | 'cli',
          auth,
          hostId,
          sessionId: u.searchParams.get('sessionId')!,
          history: true,
          epoch: 0,
          authenticated: false,
          deadline: Date.now() + 15000,
        });
      }
      if (u.pathname === '/web')
        return await this.upgrade(req, {
          role: 'web',
          auth,
          hostId,
          sessionId: u.searchParams.get('sessionId')!,
          epoch: 0,
          authenticated: false,
          deadline: Date.now() + 5000,
        });
      throw new AppError('NOT_FOUND', 'Unknown route', 404);
    } catch (e) {
      return failure(e);
    }
  }
  async consume(
    value: string,
    sessionId: string,
    mode: 'web' | 'cli',
    ownerHash?: string,
  ) {
    const key = 'ticket:' + (await digest(value));
    return this.ctx.storage.transaction(async (tx) => {
      const t = await tx.get<Ticket>(key);
      if (
        !t ||
        t.expires < Date.now() ||
        t.sessionId !== sessionId ||
        t.mode !== mode ||
        (ownerHash && t.hash !== ownerHash)
      )
        throw new AppError(
          'UNAUTHORIZED',
          'Invalid or consumed connection ticket',
          401,
        );
      await tx.delete(key);
      return t;
    });
  }
  async reserve(sessionId: string, takeover: boolean) {
    return this.ctx.storage.transaction(async (tx) => {
      const key = 'lease:' + sessionId;
      const lease = (await tx.get<Lease>(key)) || { epoch: 0, active: false };
      if (lease.pending && lease.pending.expires > Date.now())
        throw new AppError('SESSION_BUSY', 'Attach in progress', 409);
      if (
        lease.active &&
        (!lease.expires || lease.expires > Date.now()) &&
        !takeover
      )
        throw new AppError('SESSION_BUSY', 'Session already controlled', 409);
      const pending = {
        epoch: Math.max(lease.epoch, lease.pending?.epoch || 0) + 1,
        id: crypto.randomUUID(),
        expires: Date.now() + 15000,
      };
      await tx.put(key, { ...lease, pending });
      return pending;
    });
  }

  async upgrade(req: Request, a: Attachment) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      throw new AppError('UPGRADE_REQUIRED', 'WebSocket required', 426);
    if (this.ctx.getWebSockets().length >= 40)
      throw new AppError('CAPACITY', 'Host connection budget exhausted', 429);
    if (a.role !== 'agent' && !a.subscription && !this.agent())
      throw new AppError('HOST_OFFLINE', 'Host is offline', 503);
    if (a.role === 'agent') {
      for (const ws of this.ctx.getWebSockets())
        if (!(ws.deserializeAttachment() as Attachment).subscription)
          ws.close(1012, 'Agent reconnected');
      await this.ctx.storage.put('agentEpoch', a.epoch);
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [
      a.role,
      ...(a.sessionId ? ['session:' + a.sessionId] : []),
    ]);
    a.id = crypto.randomUUID();
    pair[1].serializeAttachment(a);
    if (!a.authenticated)
      await expireAt(this.ctx.storage, 'handshake:' + a.id, a.deadline);
    if (a.role === 'agent')
      this.send(pair[1], {
        v: 1,
        minProtocol: 1,
        type: 'hello',
        epoch: a.epoch,
        demand: 1,
      });
    if (a.subscription)
      this.send(pair[1], {
        type: 'subscribed',
        revision: (await this.ctx.storage.get('revision')) || 0,
        demand: 1,
      });
    if (a.history)
      await this.start({
        auth: a.auth,
        hostId: a.hostId,
        socketId: a.id,
        kind: 'history-open',
        action: 'get',
        data: { sessionId: a.sessionId },
        stage: 'get',
      });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    const bytes =
      typeof raw === 'string'
        ? new TextEncoder().encode(raw).length
        : raw.byteLength;
    let queue = this.messages.get(ws);
    if (!queue) {
      queue = { tail: Promise.resolve(), bytes: 0 };
      this.messages.set(ws, queue);
    }
    if (
      queue.bytes + bytes > MAX_QUEUE ||
      this.incomingBytes + bytes > MAX_QUEUE * 2
    ) {
      ws.close(4000, 'Incoming message queue full');
      return;
    }
    queue.bytes += bytes;
    this.incomingBytes += bytes;
    const started = Date.now();
    const current = queue.tail
      .catch(() => {})
      .then(() => this.handleMessage(ws, raw));
    queue.tail = current;
    try {
      await current;
    } finally {
      queue.bytes -= bytes;
      this.incomingBytes -= bytes;
      if (queue.tail === current) this.messages.delete(ws);
      console.log(
        JSON.stringify({
          event: 'host_frame',
          role: (ws.deserializeAttachment() as Attachment).role,
          bytes,
          durationMs: Date.now() - started,
          authorization: this.authMetrics,
        }),
      );
      this.authMetrics = { hits: 0, misses: 0, coalesced: 0 };
    }
  }
  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let requestId: string | undefined;
    try {
      if (typeof raw !== 'string')
        throw new AppError('INVALID_REQUEST', 'Text frames required');
      const a = ws.deserializeAttachment() as Attachment;
      if (a.deadline <= Date.now())
        throw new AppError('UNAUTHORIZED', 'Connection expired', 401);
      await this.authorized(a.auth.hash);
      const d = parseFrame(raw);
      if (typeof d.requestId === 'string' && d.requestId.length <= 100)
        requestId = d.requestId;
      if (d.type === 'receipt' && typeof d.receiptId === 'string') {
        const [seq, bytes] = d.receiptId.split(':').map(Number),
          counter = a.receipts;
        if (
          counter &&
          Number.isSafeInteger(seq) &&
          Number.isSafeInteger(bytes) &&
          seq > counter.ack &&
          seq <= counter.seq &&
          bytes >= counter.acked &&
          bytes <= counter.sent
        ) {
          counter.ack = seq;
          counter.acked = bytes;
          ws.serializeAttachment(a);
        }
        return;
      }
      if (a.subscription)
        throw new AppError(
          'FORBIDDEN',
          'Notification channel is read only',
          403,
        );
      if (a.role === 'agent') {
        if (d.v !== undefined && d.v !== 1)
          throw new AppError('PROTOCOL_MISMATCH', 'Unsupported protocol', 409);
        if (d.type === 'capabilities') {
          if (d.protocol !== 1)
            throw new AppError(
              'PROTOCOL_MISMATCH',
              'Unsupported Agent protocol',
              409,
            );
          a.protocol = d.protocol;
          a.build = agentBuildSchema.parse(d.build);
          if (d.wakeUrl !== undefined)
            await registryCall(this.env, 'agentSetWakeUrl', {
              agentHash: a.auth.hash,
              wakeUrl: wakeUrlSchema.parse(d.wakeUrl),
            });
          if (d.displayName !== undefined)
            await registryCall(this.env, 'setInstanceName', {
              hash: a.auth.hash,
              displayName: d.displayName,
            });
          ws.serializeAttachment(a);
          await this.changed();
          return;
        }
        if (a.epoch !== (await this.ctx.storage.get('agentEpoch')))
          throw new AppError('STALE_AGENT', 'Old Agent connection');
        if (d.type === 'ping') {
          this.send(ws, { type: 'pong' });
          return;
        }
        if (d.type === 'result') {
          const operationId = await this.ctx.storage.get<string>(
            'wire:' + d.requestId,
          );
          const operation = operationId
            ? await this.loadOperation(operationId)
            : undefined;
          if (
            operation &&
            operation.state === 'pending' &&
            operation.wire === d.requestId &&
            operation.agentEpoch === a.epoch &&
            operation.expires > Date.now()
          ) {
            await this.ctx.storage.delete('wire:' + d.requestId);
            try {
              await this.result(operation, d.data, d.error);
            } catch (error) {
              await this.complete(operation, undefined, error);
            }
          }
          return;
        }
        if (
          d.type === 'event' &&
          [
            'sessionClosed',
            'externalState',
            'turn/started',
            'turn/completed',
          ].includes(d.payload?.event?.type)
        )
          await this.changed('sessions');
        if (['rpc', 'event', 'notice'].includes(d.type)) {
          const bytes = new TextEncoder().encode(
            JSON.stringify(d.payload),
          ).length;
          for (const client of this.ctx.getWebSockets(
            'session:' + d.sessionId,
          )) {
            const ca = client.deserializeAttachment() as Attachment;
            if (
              !ca.authenticated ||
              (!ca.history && ca.epoch !== d.epoch) ||
              (d.type === 'event' && ca.historyEvents && !ca.history)
            )
              continue;
            if (ca.history) {
              if (d.type === 'event') this.forward(client, d.payload, bytes);
              continue;
            }
            if (d.type === 'rpc' && ca.role === 'cli')
              this.forward(client, d.payload, bytes);
            if (d.type !== 'rpc' && ca.role === 'web')
              this.forward(client, d.payload, bytes);
          }
        }
        return;
      }
      if (a.history) {
        const { requestId, ...data } = historyCommandSchema.parse(d);
        if (!a.authenticated)
          throw new AppError(
            'AGENT_NEGOTIATING',
            'Wait for history-ready',
            409,
          );
        await this.start({
          auth: a.auth,
          hostId: a.hostId,
          socketId: a.id,
          clientRequestId: requestId,
          kind: 'history',
          stage: 'execute',
          action: 'history',
          data: { ...data, sessionId: a.sessionId },
        });
        return;
      }
      if (!a.authenticated) {
        if (d.type !== 'auth' || typeof d.ticket !== 'string')
          throw new AppError('UNAUTHORIZED', 'Connection ticket required', 401);
        const t = await this.consume(
          d.ticket,
          a.sessionId!,
          'web',
          a.auth.hash,
        );
        a.historyEvents = d.events === 'history';
        ws.serializeAttachment(a);
        await this.start({
          auth: a.auth,
          hostId: a.hostId,
          socketId: a.id,
          kind: 'attach',
          stage: 'get',
          action: 'attach',
          data: { sessionId: a.sessionId, takeover: t.takeover },
        });
        return;
      }
      const lease = await this.ctx.storage.get<{ epoch: number }>(
        'lease:' + a.sessionId,
      );
      if (lease?.epoch !== a.epoch)
        throw new AppError('STALE_CONTROLLER', 'Controller replaced');
      const agent = this.agent();
      if (!agent) throw new AppError('HOST_OFFLINE', 'Host offline');
      await this.authorized(
        (agent.deserializeAttachment() as Attachment).auth.hash,
      );
      this.send(agent, {
        v: 1,
        type: a.role === 'cli' ? 'rpc' : 'web',
        sessionId: a.sessionId,
        epoch: a.epoch,
        payload: a.role === 'web' ? webCommandSchema.parse(d) : d,
      });
    } catch (e) {
      try {
        this.send(ws, {
          type: 'error',
          requestId,
          error:
            e instanceof AppError
              ? { code: e.code, message: e.message }
              : { code: 'INVALID_REQUEST', message: 'Invalid message' },
        });
      } finally {
        const history = (ws.deserializeAttachment() as Attachment)?.history;
        if (!(
          history &&
          e instanceof AppError &&
          [
            'CONTENT_CHANGED',
            'CONTENT_NOT_FOUND',
            'HOST_OFFLINE',
            'RESULT_UNKNOWN',
          ].includes(e.code)
        ))
          ws.close(4000, 'Connection rejected');
      }
    }
  }
  async webSocketClose(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment;
    if (a.id)
      for (const o of (
        await this.ctx.storage.list<Operation>({ prefix: 'operation:' })
      ).values()) {
        if (o.socketId === a.id) await this.deleteOperation(o.id);
      }
    if (a.history || a.subscription) return;
    if (a.role === 'agent') {
      if (a.epoch !== (await this.ctx.storage.get('agentEpoch'))) return;
      for (const c of this.ctx.getWebSockets())
        if (c !== ws && !(c.deserializeAttachment() as Attachment).subscription)
          c.close(1012, 'Agent disconnected');
      await this.changed();
      return;
    }
    if (!a.authenticated) return;
    const detached = await this.ctx.storage.transaction(async (tx) => {
      const key = 'lease:' + a.sessionId;
      const current = await tx.get<Lease>(key);
      if (current?.epoch !== a.epoch) return false;
      await tx.put(key, { ...current, active: false });
      return true;
    });
    if (detached) {
      const agent = this.agent();
      if (agent) {
        await this.authorized(
          (agent.deserializeAttachment() as Attachment).auth.hash,
        );
        this.send(agent, {
          type: 'detach',
          sessionId: a.sessionId,
          epoch: a.epoch,
        });
      }
    }
  }

  async webSocketError(ws: WebSocket) {
    ws.close(1011, 'Transport error');
    await this.webSocketClose(ws);
  }
  async alarm() {
    const s = this.ctx.storage;
    await migrateExpiry(s, ['ticket:']);
    for (const [index, { key }] of await dueEntries(s)) {
      if (key.startsWith('handshake:')) {
        const ws = this.socket(key.slice(10));
        const a = ws?.deserializeAttachment() as Attachment | undefined;
        if (ws && a && !a.authenticated && a.deadline <= Date.now()) {
          this.send(ws, {
            type: 'error',
            error: {
              code: 'RESULT_UNKNOWN',
              message: 'Handshake unconfirmed; refresh before retrying',
            },
          });
          ws.close(4002, 'Handshake unconfirmed');
        }
      } else {
        const value = await s.get<any>(key);
        if (value?.expires <= Date.now()) {
          if (value.wire) await s.delete('wire:' + value.wire);
          if (key.startsWith('ticket:') && value.epoch)
            await s.transaction(async (tx) => {
              const lease = await tx.get<Lease>('lease:' + value.sessionId);
              if (lease?.epoch === value.epoch)
                await tx.put('lease:' + value.sessionId, {
                  ...lease,
                  active: false,
                });
            });
          if (key.startsWith('operation:'))
            await this.deleteOperation(key.slice(10));
          else await s.delete(key);
        }
      }
      await s.delete(index);
    }
    await nextExpiry(s);
  }
}

function agentErrorStatus(code: string) {
  if (code === 'UNAUTHORIZED') return 401;
  if (code === 'FORBIDDEN') return 403;
  if (['CAPACITY', 'BACKPRESSURE'].includes(code)) return 429;
  if (
    ['SESSION_NOT_FOUND', 'CONTENT_NOT_FOUND', 'PROJECT_NOT_FOUND'].includes(
      code,
    )
  )
    return 404;
  if (code === 'MESSAGE_TOO_LARGE') return 413;
  if (code === 'RESULT_UNKNOWN') return 504;
  if (['STORAGE_ERROR', 'INTERNAL_ERROR', 'FILE_IO'].includes(code)) return 500;
  return 409;
}

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import {
  AppError,
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
  registryCall,
  token,
  type Auth,
  type Env,
} from './common.ts';

type Attachment = {
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
};
type Lease = {
  epoch: number;
  active: boolean;
  pending?: { epoch: number; id: string; expires: number };
};
export class HostRelayDO extends DurableObject<Env> {
  private authorization = new Map<
    string,
    { expires: number; checked: number }
  >();
  private outbound = new WeakMap<
    WebSocket,
    { receipts: Map<string, number>; bytes: number }
  >();
  private authorizing = new Map<
    string,
    { promise: Promise<void>; token: object }
  >();
  private authorizationVersion = 0;
  private incomingBytes = 0;
  private forwardingBytes = 0;
  private outboundBytes = 0;
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
    )
      return;
    const active = this.authorizing.get(hash);
    if (active) return active.promise;
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
  pending = new Map<
    string,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  agent() {
    return this.ctx.getWebSockets('agent').find((s) => s.readyState === 1);
  }
  send(ws: WebSocket, data: unknown) {
    const attachment = ws.deserializeAttachment() as Attachment | undefined;
    const receipts =
      attachment?.history ||
      (attachment?.role === 'web' && attachment.authenticated);
    const receiptId = receipts ? crypto.randomUUID() : undefined;
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
      let queue = this.outbound.get(ws);
      if (!queue) {
        queue = { receipts: new Map(), bytes: 0 };
        this.outbound.set(ws, queue);
      }
      if (
        queue.bytes + bytes > MAX_QUEUE ||
        this.outboundBytes + bytes > MAX_QUEUE * 2 ||
        queue.receipts.size >= 1000
      ) {
        ws.close(4008, 'Reader acknowledgement budget exhausted');
        return;
      }
      queue.receipts.set(receiptId, bytes);
      queue.bytes += bytes;
      this.outboundBytes += bytes;
    }
    ws.send(value);
  }

  async command(action: string, data: any) {
    data = controlCommandSchema.parse({ action, data }).data;
    const ws = this.agent();
    if (!ws) throw new AppError('HOST_OFFLINE', 'Host is offline', 503);
    const agent = ws.deserializeAttachment() as Attachment;
    if (agent.protocol !== 1)
      throw new AppError(
        'AGENT_NEGOTIATING',
        'Agent must complete protocol negotiation; upgrade the Agent if this persists',
        503,
      );
    if (this.pending.size >= 64)
      throw new AppError(
        'BACKPRESSURE',
        'Host control request budget exhausted',
        429,
      );
    const requestId = crypto.randomUUID();
    const started = Date.now();
    console.log(
      JSON.stringify({
        event: 'control_started',
        action,
        requestId,
        sessionId: data?.sessionId,
        pending: this.pending.size,
      }),
    );
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        console.log(
          JSON.stringify({
            event: 'control_timeout',
            action,
            requestId,
            durationMs: Date.now() - started,
          }),
        );
        reject(
          new AppError(
            'RESULT_UNKNOWN',
            'Agent did not confirm the request; check session state before retrying',
            504,
          ),
        );
      }, 12000);
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.send(ws, { v: 1, type: 'control', requestId, action, data });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }
  async fetch(req: Request) {
    try {
      const u = new URL(req.url),
        s = this.ctx.storage;
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
        return json({
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
      if (u.pathname === '/ticket') {
        const d = await body(req),
          sessionId = z.string().parse(d.sessionId);
        const info = await this.command('get', { sessionId });
        if (info.mode !== auth.role)
          throw new AppError(
            'FORBIDDEN',
            'Wrong credential for session mode',
            403,
          );
        if (info.state !== 'ready')
          throw new AppError('SESSION_CLOSED', 'Session is not active', 409);
        if (info.mode === 'cli' && info.canReattach === false)
          throw new AppError(
            'CLI_REATTACH_UNSUPPORTED',
            'End this CLI session and create a new one',
            409,
          );
        const active = this.ctx
          .getWebSockets('session:' + sessionId)
          .some(
            (ws) =>
              (ws.deserializeAttachment() as Attachment).authenticated &&
              !(ws.deserializeAttachment() as Attachment).history,
          );
        if (active && !d.takeover)
          throw new AppError(
            'SESSION_BUSY',
            'Session already has a controller; use explicit takeover',
            409,
          );
        const value = token();
        await s.put('ticket:' + (await digest(value)), {
          sessionId,
          mode: info.mode,
          hash: auth.hash,
          expires: Date.now() + 60000,
          takeover: d.takeover === true,
        } satisfies Ticket);
        await this.schedule();
        return json({
          ticket: value,
          mode: info.mode,
          sandbox: info.sandbox,
          expiresIn: 60,
        });
      }
      if (u.pathname === '/cli') {
        const ticket = req.headers.get('x-ticket') || '',
          sessionId = u.searchParams.get('sessionId')!;
        const t = await this.consume(ticket, sessionId, 'cli');
        const a: Auth = await registryCall(this.env, 'authHash', {
          hash: t.hash,
        });
        if (a.role !== 'cli' || a.hostId !== hostId)
          throw new AppError('FORBIDDEN', 'Wrong CLI credential', 403);
        const epoch = await this.acquire(sessionId, t.takeover);
        return await this.upgrade(req, {
          role: 'cli',
          auth: a,
          hostId,
          sessionId,
          epoch,
          authenticated: true,
          deadline: a.expires,
        });
      }
      if (u.pathname === '/history') {
        const sessionId = u.searchParams.get('sessionId')!;
        const info = await this.command('get', { sessionId });
        if (info.mode !== auth.role)
          throw new AppError(
            'FORBIDDEN',
            'Wrong credential for session mode',
            403,
          );
        return await this.upgrade(req, {
          role: auth.role as 'web' | 'cli',
          auth,
          hostId,
          sessionId,
          history: true,
          epoch: 0,
          authenticated: true,
          deadline: auth.expires,
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
      if (u.pathname === '/control') {
        const d = await body(req);
        if (d.action === 'stop') {
          const info = await this.command('get', {
            sessionId: d.data.sessionId,
          });
          if (info.mode !== auth.role)
            throw new AppError(
              'FORBIDDEN',
              'Wrong credential for session mode',
              403,
            );
        }
        const result = await this.command(d.action, d.data);
        return json(result);
      }
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
  async acquire(sessionId: string, takeover: boolean) {
    const sockets = this.ctx
      .getWebSockets('session:' + sessionId)
      .filter((ws) => {
        const a = ws.deserializeAttachment() as Attachment;
        return a.authenticated && !a.history;
      });
    const key = 'lease:' + sessionId;
    const reservation = await this.ctx.storage.transaction(async (tx) => {
      const lease = (await tx.get<Lease>(key)) || { epoch: 0, active: false };
      if (lease.pending && lease.pending.expires > Date.now())
        throw new AppError(
          'SESSION_BUSY',
          'Session attach is in progress',
          409,
        );
      if (lease.active && !takeover)
        throw new AppError('SESSION_BUSY', 'Session already controlled', 409);
      const pending = {
        epoch: Math.max(lease.epoch, lease.pending?.epoch || 0) + 1,
        id: crypto.randomUUID(),
        expires: Date.now() + 15000,
      };
      await tx.put(key, { ...lease, pending });
      return pending;
    });
    try {
      await this.command('attach', {
        sessionId,
        epoch: reservation.epoch,
        expires: reservation.expires,
      });
      await this.ctx.storage.transaction(async (tx) => {
        const lease = await tx.get<Lease>(key);
        if (lease?.pending?.id !== reservation.id)
          throw new AppError(
            'STALE_CONTROLLER',
            'Attach reservation replaced',
            409,
          );
        await tx.put(key, {
          epoch: reservation.epoch,
          active: true,
        } satisfies Lease);
      });
      for (const ws of sockets) ws.close(4009, 'Control taken over');
      return reservation.epoch;
    } catch (error) {
      // A lost confirmation may already have changed the Agent epoch. Keep that
      // reservation fenced until its deadline; never restore an unconfirmed epoch.
      if (!(error instanceof AppError) || error.code !== 'RESULT_UNKNOWN')
        await this.ctx.storage.transaction(async (tx) => {
          const lease = await tx.get<Lease>(key);
          if (lease?.pending?.id === reservation.id) {
            const { pending: _pending, ...previous } = lease;
            await tx.put(key, previous);
          }
        });
      throw error;
    }
  }

  async upgrade(req: Request, a: Attachment) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      throw new AppError('UPGRADE_REQUIRED', 'WebSocket required', 426);
    if (this.ctx.getWebSockets().length >= 40)
      throw new AppError('CAPACITY', 'Host connection budget exhausted', 429);
    if (a.role !== 'agent' && !this.agent())
      throw new AppError('HOST_OFFLINE', 'Host is offline', 503);
    if (a.role === 'agent') {
      for (const ws of this.ctx.getWebSockets())
        ws.close(1012, 'Agent reconnected');
      await this.ctx.storage.put('agentEpoch', a.epoch);
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [
      a.role,
      ...(a.sessionId ? ['session:' + a.sessionId] : []),
    ]);
    pair[1].serializeAttachment(a);
    await this.schedule();
    if (a.role === 'agent')
      this.send(pair[1], {
        v: 1,
        minProtocol: 1,
        type: 'hello',
        epoch: a.epoch,
      });
    if (a.history) this.send(pair[1], { type: 'history-ready' });
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
        const queue = this.outbound.get(ws);
        const bytes = queue?.receipts.get(d.receiptId);
        if (queue && bytes !== undefined) {
          queue.bytes -= bytes;
          this.outboundBytes -= bytes;
          queue.receipts.delete(d.receiptId);
        }
        return;
      }
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
          ws.serializeAttachment(a);
          return;
        }
        if (a.epoch !== (await this.ctx.storage.get('agentEpoch')))
          throw new AppError('STALE_AGENT', 'Old Agent connection');
        if (d.type === 'ping') {
          this.send(ws, { type: 'pong' });
          return;
        }
        if (d.type === 'result') {
          const p = this.pending.get(d.requestId);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(d.requestId);
            if (d.error)
              p.reject(
                new AppError(
                  d.error.code,
                  d.error.message,
                  agentErrorStatus(d.error.code),
                ),
              );
            else p.resolve(d.data);
          }
          return;
        }
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
        const result = await this.command('history', {
          ...data,
          sessionId: a.sessionId,
        });
        this.send(ws, { type: 'history', requestId, ...result });
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
        a.epoch = await this.acquire(a.sessionId!, t.takeover);
        a.authenticated = true;
        a.historyEvents = d.events === 'history';
        a.deadline = a.auth.expires;
        ws.serializeAttachment(a);
        this.send(ws, { type: 'attached', epoch: a.epoch });
        return;
      }
      const lease = await this.ctx.storage.get<{ epoch: number }>(
        'lease:' + a.sessionId,
      );
      if (lease?.epoch !== a.epoch)
        throw new AppError('STALE_CONTROLLER', 'Controller replaced');
      const agent = this.agent();
      if (!agent) throw new AppError('HOST_OFFLINE', 'Host offline');
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
    const queue = this.outbound.get(ws);
    if (queue) {
      this.outboundBytes -= queue.bytes;
      this.outbound.delete(ws);
    }
    if ((ws.deserializeAttachment() as Attachment)?.history) return;
    const a = ws.deserializeAttachment() as Attachment;
    if (a.role === 'agent') {
      if (a.epoch !== (await this.ctx.storage.get('agentEpoch'))) return;
      for (const c of this.ctx.getWebSockets())
        if (c !== ws) c.close(1012, 'Agent disconnected');
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
      if (agent)
        this.send(agent, {
          type: 'detach',
          sessionId: a.sessionId,
          epoch: a.epoch,
        });
    }
  }

  async webSocketError(ws: WebSocket) {
    ws.close(1011, 'Transport error');
    await this.webSocketClose(ws);
  }
  async schedule() {
    const current = await this.ctx.storage.getAlarm();
    const at = Date.now() + 5000;
    if (!current || current > at) await this.ctx.storage.setAlarm(at);
  }
  async alarm() {
    const sockets = this.ctx.getWebSockets();
    const hashes = [
      ...new Set(
        sockets.map(
          (ws) => (ws.deserializeAttachment() as Attachment).auth.hash,
        ),
      ),
    ];
    const rejected = new Set<string>();
    // Keep the existing revocation bound; deduplicate credentials and cap concurrency.
    for (let i = 0; i < hashes.length; i += 4)
      await Promise.all(
        hashes.slice(i, i + 4).map(async (hash) => {
          try {
            await this.authorized(hash);
          } catch {
            rejected.add(hash);
          }
        }),
      );
    for (const ws of sockets) {
      const a = ws.deserializeAttachment() as Attachment;
      if (a.deadline <= Date.now() || rejected.has(a.auth.hash))
        ws.close(4001, 'Authorization expired or revoked');
    }
    for (const [k, t] of await this.ctx.storage.list<Ticket>({
      prefix: 'ticket:',
    }))
      if (t.expires < Date.now()) await this.ctx.storage.delete(k);
    if (this.ctx.getWebSockets().length)
      await this.ctx.storage.setAlarm(Date.now() + 30000);
  }
}

function agentErrorStatus(code: string) {
  if (['FORBIDDEN', 'UNAUTHORIZED'].includes(code))
    return code === 'FORBIDDEN' ? 403 : 401;
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

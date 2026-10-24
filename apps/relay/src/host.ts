import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import {
  AppError,
  MAX_QUEUE,
  parseFrame,
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
  deadline: number;
};
type Ticket = {
  sessionId: string;
  mode: 'web' | 'cli';
  hash: string;
  expires: number;
  takeover: boolean;
};
export class HostRelayDO extends DurableObject<Env> {
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
    const value = typeof data === 'string' ? data : JSON.stringify(data);
    // The runtime doesn't expose bufferedAmount on every release. Cap individual frames;
    // the Node endpoints additionally enforce the aggregate queue limit.
    if (new TextEncoder().encode(value).length > MAX_QUEUE)
      throw new AppError('MESSAGE_TOO_LARGE', 'Outgoing frame too large');
    ws.send(value);
  }
  async command(action: string, data: any) {
    const ws = this.agent();
    if (!ws) throw new AppError('HOST_OFFLINE', 'Host is offline', 503);
    const requestId = crypto.randomUUID();
    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
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
      if (u.pathname === '/status') return json({ online: !!this.agent() });
      if (u.pathname === '/revoke-auth') {
        const d = await body(req);
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
        const active = this.ctx
          .getWebSockets('session:' + sessionId)
          .some(
            (ws) => (ws.deserializeAttachment() as Attachment).authenticated,
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
      .filter((ws) => (ws.deserializeAttachment() as Attachment).authenticated);
    const epoch = await this.ctx.storage.transaction(async (tx) => {
      const lease = (await tx.get<{ epoch: number; active: boolean }>(
        'lease:' + sessionId,
      )) || { epoch: 0, active: false };
      if (lease.active && sockets.length && !takeover)
        throw new AppError('SESSION_BUSY', 'Session already controlled', 409);
      await tx.put('lease:' + sessionId, {
        epoch: lease.epoch + 1,
        active: true,
      });
      return lease.epoch + 1;
    });
    for (const ws of sockets) ws.close(4009, 'Control taken over');
    // Establish epoch at Agent before the new controller can issue commands.
    await this.command('attach', { sessionId, epoch });
    return epoch;
  }
  async upgrade(req: Request, a: Attachment) {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket')
      throw new AppError('UPGRADE_REQUIRED', 'WebSocket required', 426);
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
      this.send(pair[1], { v: 1, type: 'hello', epoch: a.epoch });
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
    if (queue.bytes + bytes > MAX_QUEUE) {
      ws.close(4000, 'Incoming message queue full');
      return;
    }
    queue.bytes += bytes;
    const current = queue.tail
      .catch(() => {})
      .then(() => this.handleMessage(ws, raw));
    queue.tail = current;
    try {
      await current;
    } finally {
      queue.bytes -= bytes;
      if (queue.tail === current) this.messages.delete(ws);
    }
  }
  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    try {
      if (typeof raw !== 'string')
        throw new AppError('INVALID_REQUEST', 'Text frames required');
      const a = ws.deserializeAttachment() as Attachment;
      if (a.deadline <= Date.now())
        throw new AppError('UNAUTHORIZED', 'Connection expired', 401);
      await registryCall(this.env, 'authHash', { hash: a.auth.hash });
      const d = parseFrame(raw);
      if (a.role === 'agent') {
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
              p.reject(new AppError(d.error.code, d.error.message, 409));
            else p.resolve(d.data);
          }
          return;
        }
        if (['rpc', 'event', 'notice'].includes(d.type)) {
          for (const client of this.ctx.getWebSockets(
            'session:' + d.sessionId,
          )) {
            const ca = client.deserializeAttachment() as Attachment;
            if (!ca.authenticated || ca.epoch !== d.epoch) continue;
            try {
              await registryCall(this.env, 'authHash', { hash: ca.auth.hash });
            } catch {
              client.close(4001, 'Authorization revoked');
              continue;
            }
            if (d.type === 'rpc' && ca.role === 'cli')
              this.send(client, d.payload);
            if (d.type !== 'rpc' && ca.role === 'web')
              this.send(client, d.payload);
          }
        }
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
        payload: d,
      });
    } catch (e) {
      try {
        this.send(ws, {
          type: 'error',
          error:
            e instanceof AppError
              ? { code: e.code, message: e.message }
              : { code: 'INVALID_REQUEST', message: 'Invalid message' },
        });
      } finally {
        ws.close(4000, 'Connection rejected');
      }
    }
  }
  async webSocketClose(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment;
    if (a.role === 'agent') {
      if (a.epoch !== (await this.ctx.storage.get('agentEpoch'))) return;
      for (const c of this.ctx.getWebSockets())
        if (c !== ws) c.close(1012, 'Agent disconnected');
      return;
    }
    if (!a.authenticated) return;
    const current = await this.ctx.storage.get<{ epoch: number }>(
      'lease:' + a.sessionId,
    );
    if (current?.epoch === a.epoch) {
      await this.ctx.storage.put('lease:' + a.sessionId, {
        epoch: a.epoch,
        active: false,
      });
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
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      try {
        if (a.deadline <= Date.now()) throw new Error('expired');
        await registryCall(this.env, 'authHash', { hash: a.auth.hash });
      } catch {
        ws.close(4001, 'Authorization expired or revoked');
      }
    }
    for (const [k, t] of await this.ctx.storage.list<Ticket>({
      prefix: 'ticket:',
    }))
      if (t.expires < Date.now()) await this.ctx.storage.delete(k);
    if (this.ctx.getWebSockets().length)
      await this.ctx.storage.setAlarm(Date.now() + 30000);
  }
}

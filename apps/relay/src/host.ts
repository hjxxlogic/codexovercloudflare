import { DurableObject } from 'cloudflare:workers';
import { live, retire } from './connections.ts';
import { managesProjects } from './project-auth.ts';
import {
  body,
  digest,
  failure,
  json,
  registryCall,
  type Auth,
  type Env,
} from './common.ts';
import {
  AppError,
  MAX_FRAME,
  MAX_QUEUE,
  wakeUrlSchema,
} from '../../../packages/protocol/src/admission.ts';

type Attachment = {
  id: string;
  kind: 'agent' | 'client' | 'manager';
  auth: Auth;
  hostId: string;
  policy: string;
  retired?: boolean;
  blocked?: boolean;
  target?: string;
  deadline: number;
  link?: string;
  peer?: string;
  bound?: boolean;
  key?: string;
  permissions?: { access: boolean; projects: boolean; configuration: boolean };
};
type Retirement = {
  event: string;
  link: string;
  socket: string;
  kind: string;
  target?: string;
};
type Pending = {
  target: string;
  resolve: () => void;
  reject: () => void;
  timer: ReturnType<typeof setTimeout>;
};
// Only connection identities, authorization and opaque records enter this DO.
export class HostRelayDO extends DurableObject<Env> {
  private pending = new Map<string, Pending>();
  private authorizationPass?: Promise<void>;
  private async authorizedFlow() {
    for (let pass; (pass = this.authorizationPass);) {
      await pass.catch(() => {});
      if (this.authorizationPass === pass) return;
    }
  }
  private queued = 0;
  private records = 0;
  private tails = new WeakMap<WebSocket, Promise<void>>();
  private restored?: Promise<void>;
  private async policy() {
    return digest(
      JSON.stringify([
        this.env.OWNER_SECRET,
        this.env.ACCESS_ENABLED,
        this.env.ACCESS_TEAM_DOMAIN,
        this.env.ACCESS_AUD,
        this.env.ADMIN_EMAIL,
      ]),
    );
  }
  private a(ws: WebSocket) {
    return ws.deserializeAttachment() as Attachment;
  }
  private sockets() {
    return this.ctx.getWebSockets();
  }
  private byId(id?: string) {
    return this.sockets().find((ws) => this.a(ws).id === id && live(ws));
  }
  private agent() {
    return this.sockets().find(
      (ws) => this.a(ws).kind === 'agent' && this.a(ws).bound && live(ws),
    );
  }
  private target(id: string) {
    return id === 'agent'
      ? this.agent()
      : this.sockets().find(
          (ws) =>
            this.a(ws).kind === 'manager' &&
            this.a(ws).target === id &&
            this.a(ws).bound &&
            live(ws),
        );
  }
  private send(ws: WebSocket | undefined, value: unknown) {
    if (!live(ws))
      throw new AppError('HOST_OFFLINE', 'Connection unavailable', 503);
    const text = JSON.stringify(value);
    if (new TextEncoder().encode(text).length > MAX_FRAME)
      throw new AppError('MESSAGE_TOO_LARGE', 'Relay frame too large', 413);
    ws!.send(text);
  }
  private async restore() {
    if ((await this.ctx.storage.get('channelVersion')) !== 1) {
      for (const ws of this.sockets())
        retire(ws, 1012, 'Encrypted relay upgrade required');
      // Old cloud business journals must not survive the one-way switch.
      const wakeUntil = await this.ctx.storage.get<number>('wakeUntil');
      while (true) {
        const page = await this.ctx.storage.list({ limit: 128 });
        if (!page.size) break;
        await this.ctx.storage.delete([...page.keys()]);
      }
      if (wakeUntil) await this.ctx.storage.put('wakeUntil', wakeUntil);
      await this.ctx.storage.put('channelVersion', 1);
    }
    const policy = await this.policy();
    for (const ws of this.sockets()) {
      const a = this.a(ws);
      if (a.blocked || a.policy !== policy || a.deadline <= Date.now())
        this.close(ws, 1012);
    }
  }
  private close(ws: WebSocket, code = 1000) {
    const a = this.a(ws);
    if (a.retired) return;
    retire(ws, code, 'Connection closed');
    if (a.kind === 'client') {
      const peer = this.byId(a.peer);
      if (peer && a.link)
        this.send(peer, { type: 'channel-close', link: a.link });
    } else {
      for (const client of this.sockets())
        if (this.a(client).peer === a.id && !this.a(client).retired)
          this.close(client, 1012);
    }
  }
  private async upgrade(
    req: Request,
    kind: Attachment['kind'],
    auth: Auth,
    hostId: string,
  ) {
    if (this.sockets().filter(live).length >= 256)
      throw new AppError('BACKPRESSURE', 'Connection budget exhausted', 429);
    if (kind === 'agent')
      for (const ws of this.sockets())
        if (this.a(ws).kind === kind) this.close(ws, 1012);
    const pair = new WebSocketPair();
    const id = crypto.randomUUID();
    const a: Attachment = {
      id,
      kind,
      auth,
      hostId,
      policy: await this.policy(),
      deadline: Math.min(auth.expires, Date.now() + 15000),
      ...(kind === 'client'
        ? { target: new URL(req.url).searchParams.get('target') || 'agent' }
        : {}),
    };
    pair[1].serializeAttachment(a);
    this.ctx.acceptWebSocket(pair[1]);
    await this.schedule();
    this.send(pair[1], { type: 'channel-welcome', version: 1, id });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private async schedule() {
    const finite = this.sockets()
      .filter(live)
      .map((ws) => this.a(ws).deadline)
      .filter((at) => at < Number.MAX_SAFE_INTEGER);
    if (finite.length) await this.ctx.storage.setAlarm(Math.min(...finite));
    else await this.ctx.storage.deleteAlarm();
  }
  private async retirements() {
    return (await this.ctx.storage.get<Retirement[]>('retirements')) || [];
  }
  private async acknowledge(event: string, socket: string) {
    await this.ctx.storage.transaction(async (tx) => {
      const entries = (await tx.get<Retirement[]>('retirements')) || [];
      await tx.put(
        'retirements',
        entries.filter((e) => e.event !== event || e.socket !== socket),
      );
    });
    const p = this.pending.get(event);
    if (p && p.target === socket) {
      clearTimeout(p.timer);
      this.pending.delete(event);
      p.resolve();
    }
  }
  private async invalidate(event: string) {
    const pass = (this.authorizationPass || Promise.resolve())
      .catch(() => {})
      .then(() => this.invalidateNow(event));
    this.authorizationPass = pass;
    try {
      await pass;
    } finally {
      if (this.authorizationPass === pass) {
        for (const ws of this.sockets())
          if (this.a(ws).blocked && !this.a(ws).retired)
            retire(ws, 1011, 'Authorization incomplete; reconnect');
        this.authorizationPass = undefined;
      }
    }
  }
  private async invalidateNow(event: string) {
    // Persist generic connection fences before disconnecting clients. Missing
    // endpoint acknowledgements survive retries and DO reconstruction.
    const peers = this.sockets().filter(
      (ws) => !this.a(ws).retired && ws.readyState < 2,
    );
    const invalid: WebSocket[] = [];
    const clients = new Set<WebSocket>();
    for (const ws of peers)
      ws.serializeAttachment({ ...this.a(ws), blocked: true });
    for (const ws of peers) {
      const a = this.a(ws);
      try {
        const current: Auth = await registryCall(
          this.env,
          'authHash',
          { hash: a.auth.hash },
          'host',
        );
        if (
          current.role !== a.auth.role ||
          current.hostId !== a.auth.hostId ||
          current.accountId !== a.auth.accountId ||
          current.expires !== a.auth.expires
        )
          throw new Error();
        if (a.kind === 'client' && a.bound) {
          const host = await registryCall(
            this.env,
            'host',
            { id: a.hostId },
            'host',
          );
          const permissions = {
            access: ['cli', 'web'].includes(current.role),
            projects: await managesProjects(this.env, current, host),
            configuration: current.role === 'owner',
          };
          if (JSON.stringify(permissions) !== JSON.stringify(a.permissions))
            throw new Error();
        }
        if (!this.a(ws).retired)
          ws.serializeAttachment({ ...this.a(ws), blocked: false });
      } catch {
        if (a.kind === 'client') {
          clients.add(ws);
          continue;
        }
        // An unregistered uplink has never received an endpoint binding, so
        // there is no business authority to retire or acknowledge.
        if (!a.bound) this.close(ws, 4001);
        else invalid.push(ws);
      }
    }
    for (const ws of peers)
      if (
        this.a(ws).kind === 'client' &&
        invalid.some((peer) => this.a(peer).id === this.a(ws).peer)
      )
        clients.add(ws);
    for (const ws of clients)
      ws.serializeAttachment({ ...this.a(ws), blocked: true });
    const additions: Retirement[] = invalid.map((ws) => {
      const a = this.a(ws);
      return {
        event: event + ':' + a.id,
        link: '*',
        socket: a.id,
        kind: a.kind,
        target: a.target,
      };
    });
    for (const ws of clients) {
      const a = this.a(ws);
      const peer = this.sockets().find((p) => this.a(p).id === a.peer);
      if (a.link && peer)
        additions.push({
          event: event + ':' + a.link,
          link: a.link,
          socket: this.a(peer).id,
          kind: this.a(peer).kind,
          target: this.a(peer).target,
        });
    }
    await this.ctx.storage.transaction(async (tx) => {
      const entries = (await tx.get<Retirement[]>('retirements')) || [];
      for (const entry of additions)
        if (
          !entries.some(
            (e) => e.socket === entry.socket && e.link === entry.link,
          )
        )
          entries.push(entry);
      await tx.put('retirements', entries);
    });
    for (const ws of clients) this.close(ws, 4001);
    const entries = await this.retirements();
    for (const entry of entries) {
      if (
        this.pending.has(entry.event) ||
        !this.sockets().some(
          (ws) =>
            this.a(ws).id === entry.socket &&
            !this.a(ws).retired &&
            ws.readyState < 2,
        )
      )
        throw new AppError(
          'INVALIDATION_PENDING',
          'Waiting for endpoint acknowledgement or reconnection',
          503,
        );
    }
    const confirmations: Promise<void>[] = [];
    for (const entry of entries) {
      if (this.pending.has(entry.event))
        throw new AppError(
          'INVALIDATION_PENDING',
          'Endpoint acknowledgement pending',
          503,
        );
      const target = this.sockets().find(
        (ws) =>
          this.a(ws).id === entry.socket &&
          !this.a(ws).retired &&
          ws.readyState < 2,
      );
      if (!target)
        throw new AppError(
          'INVALIDATION_PENDING',
          'Waiting for endpoint reconnection',
          503,
        );
      confirmations.push(
        new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(entry.event);
            reject(
              new AppError(
                'INVALIDATION_PENDING',
                'Endpoint acknowledgement pending',
                503,
              ),
            );
          }, 5000);
          this.pending.set(entry.event, {
            target: entry.socket,
            resolve,
            reject: () =>
              reject(
                new AppError(
                  'INVALIDATION_PENDING',
                  'Endpoint disconnected',
                  503,
                ),
              ),
            timer,
          });
        }),
      );
      target.send(
        JSON.stringify({
          type: 'channel-retire',
          link: entry.link,
          event: entry.event,
        }),
      );
    }
    await Promise.all(confirmations);
    for (const ws of invalid) this.close(ws, 4001);
    await this.schedule();
  }
  async fetch(req: Request) {
    try {
      await (this.restored ??= this.restore());
      const u = new URL(req.url),
        hostId = req.headers.get('x-host') || '';
      if (u.pathname === '/authorization-change') {
        await this.invalidate(
          req.headers.get('x-coc-authorization-event') || crypto.randomUUID(),
        );
        return json({ ok: true });
      }
      if (u.pathname === '/revoke-auth') {
        await this.invalidate(crypto.randomUUID());
        return json({ ok: true });
      }
      if (u.pathname === '/status')
        return json({
          online: !!this.agent(),
          confirmed: false,
          reachability: this.agent() ? 'unconfirmed' : 'offline',
        });
      if (u.pathname === '/notify') {
        const d = await body(req),
          agent = this.agent();
        if (agent && ['requests', 'release'].includes(d.scope))
          this.send(agent, {
            type: 'change',
            scope: d.scope,
            revision: d.revision,
            ...(d.version ? { version: d.version } : {}),
          });
        return json({ ok: true });
      }
      if (u.pathname === '/wake') {
        if (this.agent()) return json({ state: 'online' });
        const host = await registryCall(
          this.env,
          'host',
          { id: hostId },
          'host',
        );
        const url = wakeUrlSchema.parse(
          host.wakeUrlOverride ?? host.agentWakeUrl ?? '',
        );
        if (!url) return json({ state: 'unconfigured' });
        const retryAfterMs = await this.ctx.storage.transaction(async (tx) => {
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
          if (!response.ok) throw new Error();
        } catch {
          throw new AppError('WAKE_FAILED', 'Wake endpoint failed', 502);
        }
        return json({ state: 'requested', retryAfterMs: 60000 });
      }
      const auth: Auth = JSON.parse(
        decodeURIComponent(req.headers.get('x-auth') || 'null'),
      );
      if (!auth || auth.expires <= Date.now())
        throw new AppError('UNAUTHORIZED', 'Invalid connection identity', 401);
      if (u.pathname === '/connections' && auth.role === 'owner')
        return json({
          targets: this.sockets()
            .filter(
              (ws) =>
                live(ws) &&
                this.a(ws).bound &&
                ['agent', 'manager'].includes(this.a(ws).kind),
            )
            .map((ws) => this.a(ws).target || 'agent'),
        });
      if (
        u.pathname === '/agent' &&
        auth.role === 'agent' &&
        auth.hostId === hostId
      )
        return this.upgrade(req, 'agent', auth, hostId);
      if (
        u.pathname === '/client-management' &&
        auth.role === 'cli' &&
        auth.hostId === hostId
      )
        return this.upgrade(req, 'manager', auth, hostId);
      if (
        u.pathname === '/channel' &&
        (auth.role === 'owner' ||
          (['cli', 'web'].includes(auth.role) && auth.hostId === hostId))
      )
        return this.upgrade(req, 'client', auth, hostId);
      throw new AppError(
        'UPGRADE_REQUIRED',
        'Use encrypted endpoint channel',
        426,
      );
    } catch (error) {
      return failure(error);
    }
  }
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    await (this.restored ??= this.restore());
    if (this.a(ws).retired || ws.readyState >= 2) return;
    const size =
      typeof raw === 'string'
        ? new TextEncoder().encode(raw).length
        : raw.byteLength;
    if (
      size > MAX_FRAME ||
      this.queued + size > MAX_QUEUE ||
      this.records >= 1024
    ) {
      this.close(ws, 1009);
      return;
    }
    // Endpoint retirement ACKs must bypass paused data, or revocation would
    // deadlock behind a frame waiting for that same acknowledgement.
    try {
      const d = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw),
      );
      if (d.type === 'channel-retired') {
        const p = this.pending.get(d.event);
        if (p && p.target === this.a(ws).id)
          await this.acknowledge(d.event, p.target);
        return;
      }
    } catch {
      /* Normal frame validation runs below. */
    }
    this.queued += size;
    this.records++;
    const previous = this.tails.get(ws) || Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        await this.authorizedFlow();
        await this.message(ws, raw);
      });
    this.tails.set(ws, task);
    try {
      await task;
    } finally {
      this.queued -= size;
      this.records--;
    }
  }
  private async message(ws: WebSocket, raw: string | ArrayBuffer) {
    if (this.a(ws).retired || ws.readyState >= 2) return;
    try {
      const d = JSON.parse(
        typeof raw === 'string' ? raw : new TextDecoder().decode(raw),
      );
      const a = this.a(ws);
      if (d.type === 'channel-retired') {
        const p = this.pending.get(d.event);
        if (p && p.target === a.id) await this.acknowledge(d.event, a.id);
        return;
      }
      if (!live(ws)) return;
      if (a.deadline <= Date.now()) {
        this.close(ws, 4001);
        return;
      }
      if (a.kind === 'client') {
        if (!a.bound) {
          if (
            d.type !== 'channel-connect' ||
            typeof d.key !== 'string' ||
            !/^[A-Za-z0-9+/]{43}=$/.test(d.key)
          )
            throw new Error('Handshake required');
          const peer = this.target(a.target || 'agent');
          if (!peer) throw new AppError('HOST_OFFLINE', 'Target offline', 503);
          if (a.target !== 'agent' && a.auth.role !== 'owner')
            throw new Error('Owner required');
          const host = await registryCall(
            this.env,
            'host',
            { id: a.hostId },
            'host',
          );
          const permissions = {
            access: ['cli', 'web'].includes(a.auth.role),
            projects: await managesProjects(this.env, a.auth, host),
            configuration: a.auth.role === 'owner',
          };
          await this.authorizedFlow();
          if (!live(ws) || !live(peer) || this.a(ws).bound) return;
          const link = crypto.randomUUID();
          const binding =
            'coc-channel-1:' +
            a.hostId +
            ':' +
            link +
            ':' +
            a.auth.hash +
            ':' +
            a.auth.role;
          ws.serializeAttachment({
            ...a,
            link,
            peer: this.a(peer).id,
            bound: true,
            deadline: a.auth.expires,
            key: d.key,
            permissions,
          });
          this.send(peer, {
            type: 'channel-open',
            version: 1,
            link,
            binding,
            key: d.key,
            identity: {
              owner: a.auth.hash,
              role: a.auth.role,
              accountId: a.auth.accountId || '',
              permissions,
              expires: a.auth.expires,
              hostId: a.hostId,
            },
          });
          await this.schedule();
          return;
        }
        if (
          !['channel-header', 'channel-data'].includes(d.type) ||
          typeof d.data !== 'string' ||
          Object.keys(d).some((k) => !['type', 'data'].includes(k))
        )
          throw new Error('Invalid opaque frame');
        this.send(this.byId(a.peer), {
          type: d.type,
          link: a.link,
          data: d.data,
        });
        return;
      }
      if (d.type === 'channel-register') {
        if (a.bound) throw new Error('Already registered');
        let target: string | undefined;
        if (a.kind === 'manager') {
          if (
            typeof d.instance !== 'string' ||
            !/^[\w-]{1,100}$/.test(d.instance)
          )
            throw new Error('Invalid process identity');
          target = 'client-' + (await digest(a.auth.hash + ':' + d.instance));
          for (const old of this.sockets())
            if (
              old !== ws &&
              this.a(old).kind === 'manager' &&
              this.a(old).target === target
            )
              this.close(old, 1012);
        }
        ws.serializeAttachment({
          ...a,
          bound: true,
          deadline: a.auth.expires,
          ...(target ? { target } : {}),
        });
        if (a.kind === 'agent') {
          const registration: Record<string, unknown> = {
            agentHash: a.auth.hash,
          };
          for (const key of [
            'wakeUrl',
            'adminEmail',
            'accessEmails',
            'displayName',
          ])
            if (d[key] !== undefined) registration[key] = d[key];
          for (const [key, operation, field] of [
            ['wakeUrl', 'agentSetWakeUrl', 'wakeUrl'],
            ['adminEmail', 'agentSetAdminEmail', 'email'],
            ['accessEmails', 'agentSetAccessEmails', 'emails'],
            ['displayName', 'setInstanceName', 'displayName'],
          ]) {
            if (registration[key] !== undefined)
              await registryCall(
                this.env,
                operation,
                {
                  [operation === 'setInstanceName' ? 'hash' : 'agentHash']:
                    a.auth.hash,
                  [field]: registration[key],
                },
                'host',
              );
          }
        }
        // A registered replacement has discarded its previous link state.
        for (const entry of await this.retirements())
          if (
            entry.socket !== a.id &&
            entry.kind === a.kind &&
            (a.kind === 'agent' || entry.target === target)
          )
            await this.acknowledge(entry.event, entry.socket);
        this.send(ws, { type: 'channel-registered' });
        await this.schedule();
        return;
      }
      if (d.type === 'channel-retired') {
        const p = this.pending.get(d.event);
        if (p && p.target === a.id) await this.acknowledge(d.event, a.id);
        return;
      }
      if (
        !a.bound ||
        ![
          'channel-key',
          'channel-header',
          'channel-data',
          'channel-close',
        ].includes(d.type) ||
        typeof d.link !== 'string'
      )
        throw new Error('Invalid target frame');
      const client = this.sockets().find(
        (c) => live(c) && this.a(c).peer === a.id && this.a(c).link === d.link,
      );
      if (!client) return;
      if (d.type === 'channel-close') {
        this.close(client, 1000);
        return;
      }
      if (typeof d.data !== 'string') throw new Error('Invalid opaque payload');
      if (d.type === 'channel-key') {
        if (!/^[A-Za-z0-9+/]{43}=$/.test(d.data))
          throw new Error('Invalid public key');
        this.send(client, {
          type: d.type,
          data: d.data,
          binding:
            'coc-channel-1:' +
            a.hostId +
            ':' +
            d.link +
            ':' +
            this.a(client).auth.hash +
            ':' +
            this.a(client).auth.role,
        });
      } else this.send(client, { type: d.type, data: d.data });
    } catch (error) {
      if (
        error instanceof AppError &&
        this.a(ws).kind === 'client' &&
        !this.a(ws).bound
      ) {
        this.send(ws, {
          type: 'channel-error',
          error: {
            code: error.code,
            message: error.message,
            status: error.status,
          },
        });
      }
      this.close(ws, 1011);
    }
  }
  async webSocketClose(ws: WebSocket) {
    this.close(ws, 1012);
    for (const [key, p] of this.pending)
      if (p.target === this.a(ws).id) {
        clearTimeout(p.timer);
        this.pending.delete(key);
        p.reject();
      }
    await this.schedule();
  }
  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }
  async alarm() {
    await (this.restored ??= this.restore());
    for (const ws of this.sockets())
      if (live(ws) && this.a(ws).deadline <= Date.now()) this.close(ws, 4001);
    await this.schedule();
  }
}

import { ManagementRequests } from './management.ts';
import {
  managementMetadataSchema,
  managementRequestSchema,
} from '../../../packages/protocol/src/management.ts';
import {
  deliveryFrameSchema,
  webDeliveryLane,
  rpcDeliveryLane,
} from '../../../packages/protocol/src/delivery.ts';
import { managesProjects, requireProjectManager } from './project-auth.ts';
import {
  d1Enabled,
  type StateStorage,
  type StateTransaction,
} from './state.ts';
import { DurableObject } from 'cloudflare:workers';
import { HostLifecycle, HOST_STATE_KEY } from './host-lifecycle.ts';
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
  errorData,
  wakeUrlSchema,
} from '../../../packages/protocol/src/index.ts';
import {
  body,
  authorizationFailed,
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
  management?: boolean;
  managementMetadata?: unknown;
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
  deliveryVersion?: number;
  deliveryInstance?: string;
  delivery?: { id: string; normal: string; priority: string };
};
type Ticket = {
  delivery?: number;
  sessionId: string;
  mode: 'web' | 'cli';
  hash: string;
  expires: number;
  takeover: boolean;
  epoch?: number;
};
type Lease = {
  epoch: number;
  nextEpoch?: number;
  active: boolean;
  owner?: string;
  controllerId?: string;
  previousControllerId?: string;
  delivery?: { id: string; normal: string; priority: string };
  expires?: number;
  pending?: { epoch: number; id: string; expires: number };
};
type Operation = {
  id: string;
  auth: Auth;
  hostId: string;
  kind:
    'control' | 'ticket' | 'history-open' | 'history' | 'attach' | 'delivery';
  data: any;
  action: string;
  stage: 'get' | 'execute' | 'attach';
  socketId?: string;
  clientRequestId?: string;
  info?: any;
  reservation?: { epoch: number; id: string; expires: number };
  wire?: string;
  agentEpoch?: number;
  agentInstance?: string;
  expires: number;
  state: 'pending' | 'completed';
  result?: any;
  error?: { code: string; message: string; status?: number };
};
export class HostRelayDO extends DurableObject<Env> {
  private state?: HostLifecycle;
  private preparing?: Promise<void>;
  private handlers = 0;
  private managementRequests = new ManagementRequests();
  private async managementTarget(a: Attachment) {
    return a.role === 'agent'
      ? 'agent'
      : 'client-' +
          (await digest(
            a.auth.hash +
              ':' +
              managementMetadataSchema.parse(a.managementMetadata).instance,
          ));
  }
  private migrationReady = false;
  private get storage(): StateStorage {
    return this.ctx.storage as unknown as StateStorage;
  }
  private async prepare(hostId?: string, activity = true) {
    if (!d1Enabled(this.env)) {
      if (await this.ctx.storage.get(HOST_STATE_KEY))
        throw new AppError(
          'STATE_MIGRATED',
          'Restore the D1 binding before using this host',
          503,
        );
      return;
    }
    if (this.preparing) await this.preparing;
    if (!hostId)
      hostId =
        (
          this.ctx.getWebSockets()[0]?.deserializeAttachment() as
            Attachment | undefined
        )?.hostId ||
        (await this.ctx.storage.get<{ hostId: string }>(HOST_STATE_KEY))
          ?.hostId ||
        (await this.ctx.storage.get<string>('@d1Host'));
    if (!hostId) return;
    if (!this.state)
      this.state = new HostLifecycle(
        this.ctx.storage as unknown as StateStorage & {
          deleteAll(): Promise<void>;
        },
        this.env.STATE_DB!,
        idSchema.parse(hostId),
      );
    if (!this.preparing)
      this.preparing = (async () => {
        const active = await this.state!.activate(activity);
        if (active && !this.migrationReady) {
          await this.presence();
          await nextExpiry(this.storage);
          this.migrationReady = true;
        }
      })().finally(() => {
        this.preparing = undefined;
      });
    await this.preparing;
  }
  private fence<T>(key: string): Promise<T | undefined> {
    return this.storage.get<T>(key);
  }
  private async presence() {
    if (!this.state) return;
    await this.storage.transaction(async (tx) => {
      const epoch = (await tx.get<number>('agentEpoch')) || 0;
      const agent = this.agent();
      const a = agent?.deserializeAttachment() as Attachment | undefined;
      await tx.put('presence', {
        online: !!agent && a?.protocol === 1 && a.epoch === epoch,
        connected: this.ctx.getWebSockets().filter((ws) => ws.readyState < 2)
          .length,
        epoch,
        updatedAt: Date.now(),
        build: a?.build,
        protocol: a?.protocol,
      });
    });
  }
  private inactive() {
    return (
      !this.handlers &&
      !this.incomingBytes &&
      !this.forwardingBytes &&
      !this.ctx.getWebSockets().some((ws) => ws.readyState < 2)
    );
  }
  private async cleanup() {
    if (!this.migrationReady || !this.state || !this.inactive()) return;
    // A short disconnect should not copy state out and straight back in.
    // Alarm checks inactivity again and copies only one bounded page per gate.
    await this.state.idle();
  }
  async fetch(req: Request) {
    this.handlers++;
    try {
      await this.prepare(req.headers.get('x-host') || undefined);
      return await this.handleFetch(req);
    } catch (error) {
      return failure(error);
    } finally {
      this.handlers--;
      await this.cleanup().catch(() =>
        console.log(JSON.stringify({ event: 'relay_cleanup_deferred' })),
      );
    }
  }

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
        if (attachment.deadline <= Date.now())
          throw new AppError('UNAUTHORIZED', 'Connection expired', 401);
        await this.authorized(attachment.auth.hash);
        if (client.readyState < 2 || client.readyState === undefined)
          this.send(
            client,
            attachment.history || attachment.delivery
              ? {
                  ...(payload as object),
                  heads: await this.heads(
                    attachment.sessionId,
                    (payload as any)?.lane === 'priority'
                      ? attachment.delivery?.priority
                      : attachment.delivery?.normal,
                  ),
                }
              : payload,
          );
      })
      .catch((error) => {
        client.close(
          authorizationFailed(error) ? 4001 : 1011,
          authorizationFailed(error)
            ? 'Authorization revoked'
            : 'Forwarding temporarily unavailable',
        );
      })
      .finally(async () => {
        queue!.bytes -= bytes;
        queue!.count--;
        this.forwardingBytes -= bytes;
        if (queue!.tail === current) this.forwards.delete(client);
        await this.cleanup();
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
    await this.storage.transaction(async (tx) => {
      const previous = await tx.get<{ parts?: number; wire?: string }>(
        'operation:' + o.id,
      );
      const parts = Math.max(
        previous?.parts || 0,
        Math.ceil(encoded.length / 16000),
      );
      const records: Record<string, unknown> = {};
      for (let i = 0; i < parts; i++)
        records[`part:${o.id}:${i}`] = encoded.slice(
          i * 16000,
          (i + 1) * 16000,
        );
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
      if (o.wire && o.state === 'pending') records['wire:' + o.wire] = o.id;
      await tx.put(records);
      if (
        previous?.wire &&
        (previous.wire !== o.wire || o.state === 'completed')
      )
        await tx.delete('wire:' + previous.wire);
    });
  }
  private async loadOperation(id: string): Promise<Operation | undefined> {
    return this.storage.transaction(async (tx) => {
      const index = await tx.get<Operation & { parts?: number }>(
        'operation:' + id,
      );
      if (!index || !index.parts) return index;
      const parts = await Promise.all(
        Array.from({ length: index.parts }, (_, i) =>
          tx.get<string>(`part:${id}:${i}`),
        ),
      );
      if (parts.some((part) => part === undefined))
        throw new AppError(
          'RESULT_UNKNOWN',
          'Incomplete operation receipt',
          409,
        );
      return JSON.parse(parts.join(''));
    });
  }
  private async deleteOperation(id: string) {
    await this.storage.transaction(async (tx) => {
      const index = await tx.get<{
        parts?: number;
        wire?: string;
        expires?: number;
      }>('operation:' + id);
      await tx.delete([
        'operation:' + id,
        ...(index?.wire ? ['wire:' + index.wire] : []),
        ...(index?.expires
          ? [`due:${String(index.expires).padStart(16, '0')}:operation:${id}`]
          : []),
        ...Array.from(
          { length: index?.parts || 0 },
          (_, i) => `part:${id}:${i}`,
        ),
      ]);
    });
  }
  private socket(id?: string) {
    return this.ctx
      .getWebSockets()
      .find((ws) => (ws.deserializeAttachment() as Attachment).id === id);
  }
  private async heads(
    sessionId?: string,
    stream?: string,
    storage: StateTransaction = this.storage,
  ) {
    if (!sessionId) return undefined;
    const lease = await storage.get<Lease>('lease:' + sessionId);
    const peer = lease?.delivery;
    const instance = (await storage.get<string>('agentInstance')) || 'legacy';
    const head = async (id: string) =>
      (await storage.get<number>('send-head:' + id)) || 0;
    const agentHead = async (id: string) => {
      const source = await storage.get<string>('head-instance:' + id);
      return source === instance || (!source && instance === 'legacy')
        ? head(id)
        : 0;
    };
    return {
      instance,
      agent: await agentHead(sessionId),
      rpc: await agentHead('rpc:' + sessionId),
      receivedByClient: lease?.owner
        ? (await storage.get<number>(
            'receive-head:' + sessionId + ':' + lease.owner,
          )) || 0
        : 0,
      ...(stream ? { client: await head(stream), stream } : {}),
      ...(peer
        ? {
            normal: {
              stream: peer.normal,
              sent: await head(peer.normal),
              resultSent: await agentHead('result:' + peer.normal),
              resultReceived: await head('result-received:' + peer.normal),
            },
            priority: {
              stream: peer.priority,
              sent: await head(peer.priority),
            },
          }
        : {}),
    };
  }
  private async controllerHeads(
    a: Attachment,
    agent: Attachment,
    stream?: string,
  ) {
    return this.storage.transaction(async (tx) => {
      const lease = await tx.get<Lease>('lease:' + a.sessionId);
      if (
        !lease?.active ||
        lease.epoch !== a.epoch ||
        (lease.owner && lease.owner !== a.auth.hash) ||
        (lease.controllerId && lease.controllerId !== a.id)
      )
        throw new AppError('STALE_CONTROLLER', 'Controller replaced', 409);
      if (agent.epoch !== (await tx.get('agentEpoch')))
        throw new AppError('STALE_AGENT', 'Agent replaced', 409);
      return this.heads(a.sessionId, stream, tx);
    });
  }
  private async advanceAgentHead(
    key: string,
    value: unknown,
    instance = 'legacy',
  ) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new AppError('INVALID_REQUEST', 'Invalid Agent publication head');
    await this.storage.transaction(async (tx) => {
      const source = await tx.get('head-instance:' + key);
      const prior = (await tx.get<number>('send-head:' + key)) || 0;
      if (source !== instance || value > prior)
        await tx.put({
          ['head-instance:' + key]: instance,
          ['send-head:' + key]:
            source === instance ? Math.max(prior, value) : value,
        });
    });
  }
  private async resultReceipt(stream: string, received: number) {
    if (!Number.isSafeInteger(received) || received < 0)
      throw new AppError('INVALID_REQUEST', 'Invalid result receipt');
    await this.storage.transaction(async (tx) => {
      const sent = (await tx.get<number>('send-head:result:' + stream)) || 0;
      if (received > sent)
        throw new AppError(
          'INVALID_REQUEST',
          'Result receipt exceeds published head',
        );
      const key = 'send-head:result-received:' + stream;
      if (received > ((await tx.get<number>(key)) || 0))
        await tx.put(key, received);
    });
  }
  private async advanceHead(key: string, value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
      throw new AppError('INVALID_REQUEST', 'Invalid published sequence');
    await this.storage.transaction(async (tx) => {
      const previous = (await tx.get<number>('send-head:' + key)) || 0;
      if (value > previous) await tx.put('send-head:' + key, value);
    });
  }
  private async changed(scope = 'host', owner?: string, operationId?: string) {
    // Notifications have no replay payload; future subscribers read a fresh
    // snapshot. Do not materialize unused host storage for an unobserved change.
    if (!this.ctx.getWebSockets().length) return;
    // Notification counters describe live transport and need no D1 round trip.
    // Native DO storage survives hibernation and is cleared after disconnect.
    const notifications = this.state ? this.ctx.storage : this.storage;
    const revision = await notifications.transaction(async (tx) => {
      const value = ((await tx.get<number>('revision')) || 0) + 1;
      await tx.put('revision', value);
      return value;
    });
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as Attachment;
      if (a.subscription && (!owner || a.auth.hash === owner))
        this.forward(ws, { type: 'change', scope, revision, operationId }, 200);
    }
  }
  async command(action: string, data: any, operation: Operation) {
    data = controlCommandSchema.parse({ action, data }).data;
    if (action === 'projectManage') {
      const current: Auth = await registryCall(this.env, 'authHash', {
        hash: operation.auth.hash,
      });
      const host = await registryCall(this.env, 'host', {
        id: operation.hostId,
      });
      if (current.role !== 'owner' && current.hostId !== host.id)
        throw new AppError('FORBIDDEN', 'Wrong Agent instance', 403);
      if (data.operation !== 'list')
        await requireProjectManager(this.env, current, host);
    }
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
    if (agent.epoch !== (await this.storage.get('agentEpoch')))
      throw new AppError('STALE_AGENT', 'Agent replaced', 409);
    const requestId = crypto.randomUUID();
    operation.wire = requestId;
    operation.agentEpoch = agent.epoch;
    operation.agentInstance = agent.deliveryInstance;
    await this.saveOperation(operation);
    this.send(ws, {
      v: 1,
      type: 'control',
      requestId,
      action,
      data,
      heads: await this.heads(data.sessionId, data.stream),
    });
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
    const existing = await this.storage.transaction(async (tx) => {
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
      this.storage,
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
    if (
      !error &&
      o.data.sessionId &&
      result &&
      typeof result === 'object' &&
      !Array.isArray(result)
    )
      result = {
        ...result,
        heads: await this.heads(o.data.sessionId, o.data.stream),
      };
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
    if (
      o.reservation &&
      (o.error || (o.socketId && (!ws || ws.readyState >= 2)))
    )
      await this.releaseReservation(o);
    if (o.socketId) {
      if (this.state && (!ws || ws.readyState >= 2)) {
        await this.saveOperation(o);
        return;
      }
      await this.deleteOperation(o.id);
      if (!ws) return;
      await this.authorized(
        (ws.deserializeAttachment() as Attachment).auth.hash,
      );
      // close/receipt handlers can run during authorization. Re-read the
      // attachment and never activate a lease for an already closed socket.
      if (ws.readyState >= 2) {
        if (o.reservation) await this.releaseReservation(o);
        return;
      }
      const a = ws.deserializeAttachment() as Attachment;
      if (o.error) {
        this.send(ws, {
          type: 'error',
          requestId: o.clientRequestId,
          error: o.error,
        });
        if (o.kind !== 'history' && o.kind !== 'delivery')
          ws.close(4000, 'Request rejected');
      } else if (o.kind === 'history')
        this.send(ws, {
          type: 'history',
          requestId: o.clientRequestId,
          heads: await this.heads(o.data.sessionId),
          ...result,
        });
      else if (o.kind === 'delivery') {
        this.send(ws, {
          type: 'delivery-window',
          heads: await this.heads(o.data.sessionId, o.data.stream),
          lane: o.data.lane,
          seq: o.data.seq,
          ...result,
        });
      } else if (o.kind === 'history-open') {
        a.authenticated = true;
        a.deadline = a.auth.expires;
        ws.serializeAttachment(a);
        this.send(ws, {
          type: 'history-ready',
          heads: await this.heads(a.sessionId),
        });
      } else {
        a.epoch = o.reservation!.epoch;
        a.authenticated = true;
        a.deadline = a.auth.expires;
        ws.serializeAttachment(a);
        this.send(ws, {
          type: 'attached',
          epoch: a.epoch,
          controller: a.id,
          heads: await this.heads(a.sessionId),
          delivery: (
            this.agent()?.deserializeAttachment() as Attachment | undefined
          )?.deliveryVersion,
        });
      }
    } else {
      await this.saveOperation(o);
      await this.changed('operation', o.auth.hash, o.id);
      if (o.action === 'create')
        await this.changed('request-results', o.auth.hash);
      if (['create', 'stop'].includes(o.action)) await this.changed('sessions');
    }
  }
  private async releaseReservation(o: Operation) {
    const reservation = o.reservation!;
    await this.storage.transaction(async (tx) => {
      const key = 'lease:' + o.data.sessionId;
      const lease = await tx.get<Lease>(key);
      if (!lease) return;
      if (lease.pending?.id === reservation.id)
        await tx.put(key, {
          ...lease,
          pending: undefined,
          nextEpoch: Math.max(lease.nextEpoch || 0, reservation.epoch),
        });
      else if (lease.epoch === reservation.epoch)
        await tx.put(key, { ...lease, active: false });
    });
    const agent = this.agent();
    if (
      agent &&
      (agent.deserializeAttachment() as Attachment).epoch === o.agentEpoch
    )
      this.send(agent, {
        type: 'detach',
        sessionId: o.data.sessionId,
        epoch: reservation.epoch,
      });
  }
  private async result(o: Operation, data: any, error?: any) {
    if (o.kind === 'attach' && o.socketId) {
      const controller = this.socket(o.socketId);
      if (!controller || controller.readyState >= 2)
        return this.complete(
          o,
          undefined,
          new AppError(
            'RESULT_UNKNOWN',
            'Connection closed before attachment was confirmed',
            409,
          ),
        );
    }
    if (error)
      return this.complete(
        o,
        undefined,
        new AppError(error.code, error.message, agentErrorStatus(error.code)),
      );
    await this.authorized(o.auth.hash);
    if (o.action === 'list') {
      const sessions = Array.isArray(data) ? data : data?.data;
      if (Array.isArray(sessions))
        for (const session of sessions)
          if (session?.heads) {
            await this.advanceAgentHead(
              session.id,
              session.heads.agent,
              o.agentInstance,
            );
            await this.advanceAgentHead(
              'rpc:' + session.id,
              session.heads.rpc,
              o.agentInstance,
            );
          }
    }
    if (o.action === 'delivery' && data?.window?.sent !== undefined)
      await this.advanceAgentHead(
        'result:' + o.data.stream,
        data.window.sent,
        o.agentInstance,
      );
    if (o.action === 'snapshot' && data?.history?.snapshotSeq !== undefined)
      await this.advanceAgentHead(
        o.data.sessionId,
        data.history.snapshotSeq,
        o.agentInstance,
      );
    if (o.kind === 'history' && data?.snapshotSeq !== undefined)
      await this.advanceAgentHead(
        o.data.sessionId,
        data.snapshotSeq,
        o.agentInstance,
      );

    if (o.action === 'projectManage') {
      const current: Auth = await registryCall(this.env, 'authHash', {
        hash: o.auth.hash,
      });
      const host = await registryCall(this.env, 'host', { id: o.hostId });
      if (o.data.operation !== 'list')
        await requireProjectManager(this.env, current, host);
      data = {
        ...data,
        canManage: await managesProjects(this.env, current, host),
      };
    }
    if (o.stage === 'get') {
      if (data.mode !== o.auth.role)
        return this.complete(
          o,
          undefined,
          new AppError('FORBIDDEN', 'Wrong credential for session mode', 403),
        );
      o.info = data;
      await this.storage.put('session-mode:' + o.data.sessionId, data.mode);
      if (o.kind === 'history-open') return this.complete(o, {});
      if (o.kind === 'ticket') {
        if (data.state !== 'ready')
          return this.complete(
            o,
            undefined,
            new AppError('SESSION_CLOSED', 'Session is not active', 409),
          );
        if (data.mode === 'cli' && data.canReattach === false && !o.data.resume)
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
        let resumeStream: string | undefined;
        if (o.data.resume) {
          const current = await this.storage.get<Lease>(
            'lease:' + o.data.sessionId,
          );
          if (
            o.auth.role !== 'cli' ||
            !current?.delivery ||
            current.owner !== o.auth.hash ||
            (current?.controllerId !== o.data.resume.controller &&
              current?.previousControllerId !== o.data.resume.controller) ||
            current?.delivery?.id !== o.data.resume.stream
          )
            throw new AppError(
              'STALE_CONTROLLER',
              'Resume proof does not match the original controller',
              409,
            );
          resumeStream = current.delivery.normal;
        }
        o.reservation = await this.reserve(
          o.data.sessionId,
          o.data.takeover || !!resumeStream,
          o.data.resume?.controller,
        );
        return this.command(
          'attach',
          {
            sessionId: o.data.sessionId,
            epoch: o.reservation.epoch,
            expires: o.reservation.expires,
            ...(resumeStream ? { deliveryResume: resumeStream } : {}),
          },
          o,
        );
      }
      o.stage = 'execute';
      return this.command(o.action, o.data, o);
    }
    if (o.stage === 'attach') {
      const controller = o.socketId ? this.socket(o.socketId) : undefined;
      if (
        o.socketId &&
        (!controller ||
          controller.readyState >= 2 ||
          (controller.deserializeAttachment() as Attachment).deadline <=
            Date.now())
      )
        return this.complete(
          o,
          undefined,
          new AppError(
            'RESULT_UNKNOWN',
            'Connection closed before attachment was confirmed',
            409,
          ),
        );
      await this.storage.transaction(async (tx) => {
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
          nextEpoch: Math.max(lease.nextEpoch || 0, o.reservation!.epoch),
          active: true,
          owner: o.auth.hash,
          controllerId: o.socketId || lease.controllerId,
          ...(o.data.resume
            ? { previousControllerId: lease.previousControllerId }
            : {}),
          ...(o.data.resume ? { delivery: lease.delivery } : {}),
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
        return ws.readyState < 2 && a.authenticated && !a.history;
      });
    if (active && !o.data.takeover && !o.data.resume)
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
    await this.storage.put(key, {
      sessionId: o.data.sessionId,
      mode: o.info.mode,
      delivery:
        o.info.mode === 'cli' && o.data.delivery === 1
          ? (this.agent()?.deserializeAttachment() as Attachment | undefined)
              ?.deliveryVersion
          : undefined,
      hash: o.auth.hash,
      expires,
      takeover: o.data.takeover === true,
      ...(o.reservation ? { epoch: o.reservation.epoch } : {}),
    } satisfies Ticket);
    await expireAt(this.storage, key, expires);
    await this.complete(o, {
      ticket: value,
      delivery:
        o.info.mode !== 'cli' || o.data.delivery === 1
          ? (this.agent()?.deserializeAttachment() as Attachment | undefined)
              ?.deliveryVersion
          : undefined,
      mode: o.info.mode,
      sandbox: o.info.sandbox,
      expiresIn: Math.max(1, Math.floor((expires - Date.now()) / 1000)),
    });
  }
  private async handleFetch(req: Request) {
    try {
      const u = new URL(req.url),
        s = this.storage;
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
          } catch (error) {
            if (!authorizationFailed(error)) throw error;
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
      if (u.pathname === '/configuration') {
        const current: Auth = await registryCall(this.env, 'authHash', {
          hash: auth.hash,
        });
        if (auth.role !== 'owner' || current.role !== 'owner')
          throw new AppError(
            'FORBIDDEN',
            'Platform administrator required',
            403,
          );
        const targets = this.ctx.getWebSockets().filter((ws) => {
          const a = ws.deserializeAttachment() as Attachment;
          return (
            ws.readyState < 2 &&
            a.authenticated &&
            a.managementMetadata &&
            a.deadline > Date.now()
          );
        });
        if (req.method === 'GET') {
          const visible = [];
          for (const ws of targets) {
            const a = ws.deserializeAttachment() as Attachment;
            try {
              await this.authorized(a.auth.hash);
              visible.push({
                id: await this.managementTarget(a),
                ...managementMetadataSchema.parse(a.managementMetadata),
              });
            } catch (error) {
              if (!authorizationFailed(error)) throw error;
            }
          }
          return json({ targets: visible }, 200, {
            'Cache-Control': 'no-store',
          });
        }
        const d = managementRequestSchema.parse(await body(req));
        let ws: WebSocket | undefined;
        for (const socket of targets) {
          const attachment = socket.deserializeAttachment() as Attachment;
          if (d.target === (await this.managementTarget(attachment))) {
            ws = socket;
            break;
          }
        }
        if (!ws)
          throw new AppError(
            'TARGET_OFFLINE',
            'Target is offline or does not support configuration management',
            409,
          );
        const a = ws.deserializeAttachment() as Attachment;
        await this.authorized(a.auth.hash);
        if (a.role === 'agent' && a.epoch !== (await this.fence('agentEpoch')))
          throw new AppError('STALE_AGENT', 'Agent replaced', 409);
        const result = await this.managementRequests.request(ws, d.command);
        const checked: Auth = await registryCall(this.env, 'authHash', {
          hash: auth.hash,
        });
        if (checked.role !== 'owner')
          throw new AppError(
            'FORBIDDEN',
            'Administrator authorization changed',
            403,
          );
        return json(result, 200, { 'Cache-Control': 'no-store' });
      }
      if (u.pathname === '/client-management') {
        if (auth.role !== 'cli' || auth.hostId !== hostId)
          throw new AppError(
            'FORBIDDEN',
            'Host-scoped client credential required',
            403,
          );
        return this.upgrade(req, {
          role: 'cli',
          auth,
          hostId,
          epoch: 0,
          authenticated: true,
          management: true,
          deadline: auth.expires,
        });
      }
      if (u.pathname === '/agent')
        return await this.upgrade(req, {
          role: 'agent',
          auth,
          hostId,
          epoch: 0,
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
      if (u.pathname === '/progress') {
        const sessionId = u.searchParams.get('sessionId') || '';
        if (
          !sessionId.startsWith(hostId + '~') ||
          !['web', 'cli'].includes(auth.role)
        )
          throw new AppError('FORBIDDEN', 'Wrong progress scope', 403);
        const mode = await this.storage.get('session-mode:' + sessionId);
        if (mode !== auth.role)
          throw new AppError('NOT_FOUND', 'No verified session progress', 404);
        return json({
          heads: await this.heads(sessionId),
          received:
            (await this.storage.get<number>(
              'receive-head:' + sessionId + ':' + auth.hash,
            )) || 0,
        });
      }
      if (u.pathname === '/delivery') {
        const d = await body(req);
        const sessionId = String(d.sessionId);
        if (
          !sessionId.startsWith(hostId + '~') ||
          !['web', 'cli'].includes(auth.role)
        )
          throw new AppError('FORBIDDEN', 'Wrong delivery session', 403);
        const external = idSchema.parse(d.stream);
        const lane =
          d.lane === 'priority'
            ? 'priority'
            : d.lane === 'normal'
              ? 'normal'
              : undefined;
        if (!lane)
          throw new AppError('INVALID_REQUEST', 'Invalid delivery lane');
        const stream = await digest(
          JSON.stringify([auth.hash, sessionId, external, lane]),
        );
        if (d.operation === 'read') {
          if (d.controller)
            await this.storage.transaction(async (tx) => {
              const current = await tx.get<Lease>('lease:' + sessionId);
              if (
                !current?.active ||
                current.owner !== auth.hash ||
                current.controllerId !== d.controller
              )
                throw new AppError(
                  'STALE_CONTROLLER',
                  'Controller replaced',
                  409,
                );
              if (current.delivery && current.delivery.id !== external)
                throw new AppError(
                  'SESSION_BUSY',
                  'Another reliable stream owns this controller',
                  409,
                );
              if (!current.delivery)
                await tx.put('lease:' + sessionId, {
                  ...current,
                  delivery: {
                    id: external,
                    normal: await digest(
                      JSON.stringify([
                        auth.hash,
                        sessionId,
                        external,
                        'normal',
                      ]),
                    ),
                    priority: await digest(
                      JSON.stringify([
                        auth.hash,
                        sessionId,
                        external,
                        'priority',
                      ]),
                    ),
                  },
                });
            });
          const data = controlCommandSchema.parse({
            action: 'delivery',
            data: {
              sessionId,
              mode: auth.role,
              stream,
              lane,
              ...(d.seq === undefined ? {} : { seq: d.seq }),
            },
          }).data;
          const operation = await this.start({
            auth,
            hostId,
            kind: 'control',
            stage: 'execute',
            action: 'delivery',
            data,
          });
          return json(
            { accepted: true, operationId: operation.id, hostId },
            202,
          );
        }
        const frame = deliveryFrameSchema.parse(d);
        if (frame.type === 'delivery-receipt') {
          await this.resultReceipt(stream, frame.received);
          return json({ ok: true, heads: await this.heads(sessionId, stream) });
        }
        if (frame.type !== 'delivery-command')
          throw new AppError('INVALID_REQUEST', 'Expected a command frame');
        const lease = await this.storage.get<Lease>('lease:' + sessionId);
        if (
          !lease?.active ||
          lease.owner !== auth.hash ||
          !lease.controllerId ||
          lease.controllerId !== d.controller ||
          lease.delivery?.id !== external
        )
          throw new AppError(
            'STALE_CONTROLLER',
            'Reliable command requires the current controller',
            409,
          );
        const agent = this.agent();
        if (!agent) throw new AppError('HOST_OFFLINE', 'Host offline', 503);
        const aa = agent.deserializeAttachment() as Attachment;
        if (aa.deliveryVersion !== 1)
          throw new AppError(
            'UPGRADE_REQUIRED',
            'Upgrade Agent for reliable commands',
            409,
          );
        await this.authorized(aa.auth.hash);
        const payload = JSON.parse(frame.body);
        if (auth.role === 'web') webCommandSchema.parse(payload);
        if (
          (auth.role === 'web'
            ? webDeliveryLane(payload)
            : rpcDeliveryLane(payload)) !== lane
        )
          throw new AppError(
            'INVALID_REQUEST',
            'Incorrect mutation command lane',
          );
        await this.advanceHead(stream, frame.seq);
        // Recheck the lease after awaits, before delivering a side effect.
        const current = await this.storage.get<Lease>('lease:' + sessionId);
        if (
          !current?.active ||
          current.epoch !== lease.epoch ||
          current.controllerId !== lease.controllerId
        )
          throw new AppError('STALE_CONTROLLER', 'Controller replaced', 409);
        const heads = await this.controllerHeads(
          {
            role: auth.role as 'cli' | 'web',
            auth,
            hostId,
            sessionId,
            epoch: lease.epoch,
            id: d.controller,
            authenticated: true,
            deadline: auth.expires,
          },
          aa,
          stream,
        );
        this.send(agent, {
          v: 1,
          type: auth.role === 'cli' ? 'rpc' : 'web',
          sessionId,
          epoch: lease.epoch,
          payload,
          delivery: {
            stream,
            lane,
            seq: frame.seq,
            end: frame.end,
            body: frame.body,
          },
          heads,
        });
        return json({ sent: true, heads: await this.heads(sessionId, stream) });
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
        const attachment: Attachment = {
          role: 'cli',
          deliveryVersion: t.delivery,
          auth: a,
          hostId,
          sessionId,
          epoch: t.epoch,
          authenticated: true,
          deadline: a.expires,
        };
        const response = await this.upgrade(req, attachment);
        await s.transaction(async (tx) => {
          const current = await tx.get<Lease>('lease:' + sessionId);
          if (current && current.epoch === t.epoch)
            await tx.put('lease:' + sessionId, {
              ...current,
              epoch: t.epoch,
              active: true,
              owner: a.hash,
              controllerId: attachment.id,
              previousControllerId:
                current.previousControllerId || current.controllerId,
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
          deadline: Date.now() + 15000,
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
    return this.storage.transaction(async (tx) => {
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
  async reserve(
    sessionId: string,
    takeover: boolean,
    expectedController?: string,
  ) {
    return this.storage.transaction(async (tx) => {
      const key = 'lease:' + sessionId;
      const lease = (await tx.get<Lease>(key)) || { epoch: 0, active: false };
      if (
        expectedController &&
        lease.controllerId !== expectedController &&
        lease.previousControllerId !== expectedController
      )
        throw new AppError(
          'STALE_CONTROLLER',
          'Controller changed during resume',
          409,
        );
      if (lease.pending && lease.pending.expires > Date.now())
        throw new AppError('SESSION_BUSY', 'Attach in progress', 409);
      if (
        lease.active &&
        (!lease.expires || lease.expires > Date.now()) &&
        (lease.expires ||
          this.ctx.getWebSockets('session:' + sessionId).some((ws) => {
            const a = ws.deserializeAttachment() as Attachment;
            return (
              ws.readyState < 2 &&
              a.authenticated &&
              !a.history &&
              a.epoch === lease.epoch
            );
          })) &&
        !takeover
      )
        throw new AppError('SESSION_BUSY', 'Session already controlled', 409);
      const pending = {
        epoch:
          Math.max(
            lease.epoch,
            lease.nextEpoch || 0,
            lease.pending?.epoch || 0,
          ) + 1,
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
    if (a.role !== 'agent' && !a.subscription && !a.management && !this.agent())
      throw new AppError('HOST_OFFLINE', 'Host is offline', 503);
    if (a.role === 'agent') {
      for (const ws of this.ctx.getWebSockets())
        if (
          !(ws.deserializeAttachment() as Attachment).subscription &&
          !(ws.deserializeAttachment() as Attachment).management
        )
          ws.close(1012, 'Agent reconnected');
      a.epoch = await this.storage.transaction(async (tx) => {
        const epoch = ((await tx.get<number>('agentEpoch')) || 0) + 1;
        await tx.put('agentEpoch', epoch);
        return epoch;
      });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [
      a.role,
      ...(a.sessionId ? ['session:' + a.sessionId] : []),
    ]);
    a.id = crypto.randomUUID();
    pair[1].serializeAttachment(a);
    if (!a.authenticated)
      await expireAt(this.storage, 'handshake:' + a.id, a.deadline);
    if (a.role === 'agent')
      this.send(pair[1], {
        v: 1,
        minProtocol: 1,
        type: 'hello',
        epoch: a.epoch,
        demand: 1,
      });
    if (a.management) this.send(pair[1], { type: 'management-ready' });
    if (a.role === 'cli' && a.deliveryVersion === 1)
      this.send(pair[1], {
        type: 'delivery-ready',
        instance: (
          this.agent()?.deserializeAttachment() as Attachment | undefined
        )?.deliveryInstance,
        controller: a.id,
        delivery: 1,
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
    await this.presence();
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
      await this.cleanup();
    }
  }
  private async handleMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let requestId: string | undefined;
    let credentialChecked = false;
    try {
      if (typeof raw !== 'string')
        throw new AppError('INVALID_REQUEST', 'Text frames required');
      const a = ws.deserializeAttachment() as Attachment;
      await this.prepare(a.hostId);
      if (a.deadline <= Date.now())
        throw new AppError('UNAUTHORIZED', 'Connection expired', 401);
      await this.authorized(a.auth.hash);
      credentialChecked = true;
      const d = parseFrame(raw);
      if (typeof d.requestId === 'string' && d.requestId.length <= 100)
        requestId = d.requestId;
      if (
        d.type === 'management-result' &&
        (a.role === 'agent' || a.management)
      ) {
        if (a.role === 'agent' && a.epoch !== (await this.fence('agentEpoch')))
          throw new AppError('STALE_AGENT', 'Old Agent connection', 409);
        this.managementRequests.reply(ws, d);
        return;
      }
      if (a.management) {
        if (d.type !== 'management-register')
          throw new AppError(
            'FORBIDDEN',
            'Client management channel only',
            403,
          );
        const metadata = managementMetadataSchema.parse(d.metadata);
        if (metadata.kind !== 'client')
          throw new AppError('INVALID_REQUEST', 'Client metadata required');
        if (!metadata.instance)
          throw new AppError('INVALID_REQUEST', 'Client instance ID required');
        for (const peer of this.ctx.getWebSockets()) {
          if (peer === ws || peer.readyState >= 2) continue;
          const previous = peer.deserializeAttachment() as Attachment;
          if (
            previous.management &&
            (previous.managementMetadata as { instance?: string } | undefined)
              ?.instance === metadata.instance
          ) {
            if (previous.auth.hash !== a.auth.hash)
              throw new AppError(
                'FORBIDDEN',
                'Client instance belongs to another credential',
                403,
              );
            peer.close(1012, 'Client management reconnected');
          }
        }
        a.managementMetadata = metadata;
        ws.serializeAttachment(a);
        return;
      }
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
        if (a.epoch !== (await this.fence('agentEpoch')))
          throw new AppError('STALE_AGENT', 'Old Agent connection');
        if (d.type === 'projects-changed') {
          await this.changed('projects');
          return;
        }
        if (d.type === 'capabilities') {
          if (d.protocol !== 1)
            throw new AppError(
              'PROTOCOL_MISMATCH',
              'Unsupported Agent protocol',
              409,
            );
          if (d.management !== undefined) {
            const metadata = managementMetadataSchema.parse(d.management);
            if (metadata.kind !== 'agent')
              throw new AppError('INVALID_REQUEST', 'Agent metadata required');
            a.managementMetadata = metadata;
          }
          a.protocol = d.protocol;
          a.deliveryVersion = d.delivery === 1 ? 1 : undefined;
          a.deliveryInstance =
            d.delivery === 1 ? idSchema.parse(d.deliveryInstance) : undefined;
          await this.storage.put(
            'agentInstance',
            a.deliveryInstance || 'legacy',
          );
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
          if (d.adminEmail !== undefined)
            await registryCall(this.env, 'agentSetAdminEmail', {
              agentHash: a.auth.hash,
              email: d.adminEmail,
            });
          if (d.accessEmails !== undefined) {
            const result = await registryCall(
              this.env,
              'agentSetAccessEmails',
              {
                agentHash: a.auth.hash,
                emails: d.accessEmails,
              },
            );
            for (const auth of result.revoked as Auth[]) {
              this.authorization.delete(auth.hash);
              this.authorizing.delete(auth.hash);
              for (const client of this.ctx.getWebSockets())
                if (
                  (client.deserializeAttachment() as Attachment).auth.hash ===
                  auth.hash
                )
                  client.close(4001, 'Email association removed');
            }
          }
          ws.serializeAttachment(a);
          await this.presence();
          await this.changed();
          return;
        }
        if (d.type === 'ping') {
          this.send(ws, { type: 'pong' });
          return;
        }
        if (d.type === 'result') {
          const operationId = await this.storage.get<string>(
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
            try {
              if (operation.data.sessionId && d.heads) {
                await this.advanceAgentHead(
                  operation.data.sessionId,
                  d.heads.agent,
                  a.deliveryInstance,
                );
                await this.advanceAgentHead(
                  'rpc:' + operation.data.sessionId,
                  d.heads.rpc,
                  a.deliveryInstance,
                );
              }
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
        if (d.sessionId && d.heads) {
          await this.advanceAgentHead(
            d.sessionId,
            d.heads.agent,
            a.deliveryInstance,
          );
          await this.advanceAgentHead(
            'rpc:' + d.sessionId,
            d.heads.rpc,
            a.deliveryInstance,
          );
        }
        if (
          d.type === 'notice' &&
          ['delivery-window', 'delivery-result'].includes(d.payload?.type) &&
          d.payload?.window?.sent !== undefined
        )
          await this.advanceAgentHead(
            'result:' + idSchema.parse(d.payload.window.stream),
            d.payload.window.sent,
            a.deliveryInstance,
          );
        if (d.type === 'rpc' && d.payload?.type === 'delivery-data')
          await this.advanceAgentHead(
            'rpc:' + d.sessionId,
            d.payload.seq,
            a.deliveryInstance,
          );
        if (d.type === 'event' && d.payload?.maxRevision !== undefined)
          await this.advanceAgentHead(
            d.sessionId,
            d.payload.maxRevision,
            a.deliveryInstance,
          );
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
            if (
              d.type !== 'rpc' &&
              (ca.role === 'web' ||
                (ca.role === 'cli' &&
                  d.type === 'notice' &&
                  String(d.payload?.type).startsWith('delivery-')))
            )
              this.forward(client, d.payload, bytes);
          }
        }
        return;
      }
      if (a.history) {
        if (
          a.authenticated &&
          Number.isSafeInteger(d.receivedRevision) &&
          d.receivedRevision >= 0
        ) {
          await this.storage.transaction(async (tx) => {
            const sent =
              (await tx.get<number>('send-head:' + a.sessionId)) || 0;
            const key = 'receive-head:' + a.sessionId + ':' + a.auth.hash;
            const previous = (await tx.get<number>(key)) || 0;
            if (d.receivedRevision <= sent && d.receivedRevision > previous)
              await tx.put(key, d.receivedRevision);
          });
        }
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
      const agent = this.agent();
      if (!agent) throw new AppError('HOST_OFFLINE', 'Host offline');
      await this.authorized(
        (agent.deserializeAttachment() as Attachment).auth.hash,
      );
      const lease = await this.fence<Lease>('lease:' + a.sessionId);
      if (lease?.epoch !== a.epoch)
        throw new AppError('STALE_CONTROLLER', 'Controller replaced');
      if (d.type === 'delivery-output') {
        if (a.role !== 'cli' || a.deliveryVersion !== 1)
          throw new AppError(
            'FORBIDDEN',
            'Reliable CLI output negotiation required',
            403,
          );
        for (const key of ['received', 'credit', 'byteCredit'])
          if (!Number.isSafeInteger(d[key]) || d[key] < 0)
            throw new AppError('INVALID_REQUEST', 'Invalid output window');
        if (d.credit < d.received || d.credit - d.received > 100)
          throw new AppError('INVALID_REQUEST', 'Invalid output slot credit');
        const published =
          (await this.storage.get<number>('send-head:rpc:' + a.sessionId)) || 0;
        if (d.received > published)
          throw new AppError(
            'INVALID_REQUEST',
            'Receipt exceeds published output',
          );
        await this.advanceHead(
          'rpc-received:' + a.sessionId + ':' + a.auth.hash,
          d.received,
        );
        this.send(agent, {
          v: 1,
          type: 'delivery-output',
          sessionId: a.sessionId,
          epoch: a.epoch,
          received: d.received,
          credit: d.credit,
          byteCredit: d.byteCredit,
          replay: d.replay === true,
          heads: await this.heads(a.sessionId, a.delivery?.normal),
        });
        return;
      }
      if (typeof d.type === 'string' && d.type.startsWith('delivery-')) {
        const frame = deliveryFrameSchema.parse(d);
        if ((agent.deserializeAttachment() as Attachment).deliveryVersion !== 1)
          throw new AppError(
            'UPGRADE_REQUIRED',
            'Agent does not support reliable commands',
            409,
          );
        if (frame.type === 'delivery-open') {
          a.delivery = {
            id: frame.stream,
            normal: await digest(
              JSON.stringify([
                a.auth.hash,
                a.sessionId,
                frame.stream,
                'normal',
              ]),
            ),
            priority: await digest(
              JSON.stringify([
                a.auth.hash,
                a.sessionId,
                frame.stream,
                'priority',
              ]),
            ),
          };
          ws.serializeAttachment(a);
          await this.storage.transaction(async (tx) => {
            const current = await tx.get<Lease>('lease:' + a.sessionId);
            if (current?.epoch !== a.epoch)
              throw new AppError(
                'STALE_CONTROLLER',
                'Controller replaced',
                409,
              );
            await tx.put('lease:' + a.sessionId, {
              ...current,
              delivery: a.delivery,
            });
          });
          for (const lane of ['normal', 'priority'] as const) {
            if (frame.received)
              await this.resultReceipt(a.delivery[lane], frame.received[lane]);
            await this.start({
              auth: a.auth,
              hostId: a.hostId,
              socketId: a.id,
              kind: 'delivery',
              stage: 'execute',
              action: 'delivery',
              data: {
                sessionId: a.sessionId,
                mode: a.role,
                lane,
                stream: a.delivery[lane],
              },
            });
          }
          return;
        }
        if (!a.delivery || a.delivery.id !== frame.stream)
          throw new AppError(
            'INVALID_REQUEST',
            'Open the delivery stream first',
          );
        const stream = a.delivery[frame.lane];
        if (frame.type === 'delivery-receipt') {
          await this.resultReceipt(stream, frame.received);
          this.send(agent, {
            type: 'delivery-heads',
            sessionId: a.sessionId,
            epoch: a.epoch,
            heads: await this.heads(a.sessionId, stream),
          });
          return;
        }
        if (frame.type === 'delivery-query') {
          await this.start({
            auth: a.auth,
            hostId: a.hostId,
            socketId: a.id,
            kind: 'delivery',
            stage: 'execute',
            action: 'delivery',
            data: {
              sessionId: a.sessionId,
              mode: a.role,
              lane: frame.lane,
              stream,
              seq: frame.seq,
            },
          });
          return;
        }
        const payload = JSON.parse(frame.body);
        if (a.role === 'web') webCommandSchema.parse(payload);
        if (
          (a.role === 'web'
            ? webDeliveryLane(payload)
            : rpcDeliveryLane(payload)) !== frame.lane
        )
          throw new AppError(
            'INVALID_REQUEST',
            'Use the original protocol for reads and the correct command lane',
          );
        await this.advanceHead(stream, frame.seq);
        const heads = await this.controllerHeads(
          a,
          agent.deserializeAttachment() as Attachment,
          stream,
        );
        this.send(agent, {
          v: 1,
          type: a.role === 'cli' ? 'rpc' : 'web',
          sessionId: a.sessionId,
          epoch: a.epoch,
          payload,
          delivery: {
            stream,
            lane: frame.lane,
            seq: frame.seq,
            end: frame.end,
            body: frame.body,
          },
          heads,
        });
        return;
      }
      const heads = await this.controllerHeads(
        a,
        agent.deserializeAttachment() as Attachment,
        a.delivery?.normal,
      );
      this.send(agent, {
        v: 1,
        type: a.role === 'cli' ? 'rpc' : 'web',
        sessionId: a.sessionId,
        epoch: a.epoch,
        payload: a.role === 'web' ? webCommandSchema.parse(d) : d,
        heads,
      });
    } catch (e) {
      try {
        this.send(ws, {
          type: 'error',
          requestId,
          error: errorData(e),
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
          ws.close(
            !credentialChecked && authorizationFailed(e)
              ? 4001
              : errorData(e).code === 'INTERNAL_ERROR'
                ? 1011
                : 4000,
            'Connection rejected',
          );
      }
    }
  }
  async webSocketClose(ws: WebSocket, code = 1000) {
    // Complete the peer's closing handshake; otherwise callers can remain in
    // CLOSING until the transport timeout and never start their recovery.
    ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, 'Closed');
    this.handlers++;
    try {
      await this.prepare((ws.deserializeAttachment() as Attachment).hostId);
      await this.closeSocket(ws);
      await this.presence();
    } finally {
      this.handlers--;
      await this.cleanup();
    }
  }
  private async closeSocket(ws: WebSocket) {
    const a = ws.deserializeAttachment() as Attachment;
    if (a.id)
      for (const o of (
        await this.storage.list<Operation>({ prefix: 'operation:' })
      ).values()) {
        if (o.socketId !== a.id) continue;
        if (o.kind === 'attach' && o.state === 'pending') {
          const pending = await this.loadOperation(o.id);
          if (pending?.reservation) await this.releaseReservation(pending);
        }
        if (!this.state) await this.deleteOperation(o.id);
      }
    if (a.history || a.subscription) return;
    if (a.role === 'agent') {
      if (a.epoch !== (await this.storage.get('agentEpoch'))) return;
      for (const c of this.ctx.getWebSockets())
        if (c !== ws && !(c.deserializeAttachment() as Attachment).subscription)
          c.close(1012, 'Agent disconnected');
      await this.changed();
      return;
    }
    if (!a.authenticated) return;
    const detached = await this.storage.transaction(async (tx) => {
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
    await this.prepare(undefined, false);
    if (this.state && this.inactive()) {
      const result = await this.ctx.blockConcurrencyWhile(async () => {
        try {
          if (!this.inactive()) return 'waiting';
          return await this.state!.archivePage();
        } catch {
          // Catch INSIDE the gate: an exception escaping its callback resets
          // the DO even when the returned promise is caught by its caller.
          await this.ctx.storage.setAlarm(Date.now() + 60_000);
          console.log(JSON.stringify({ event: 'host_archive_deferred' }));
          return 'deferred';
        }
      });
      if (result === 'deferred') return;
      if (result === 'archived') {
        this.migrationReady = false;
        return;
      }
      if (result === 'pending') {
        await this.ctx.storage.setAlarm(Date.now() + 1000);
        return;
      }
    }
    this.handlers++;
    try {
      await this.expire();
    } finally {
      this.handlers--;
      await this.cleanup();
    }
  }
  private async expire() {
    const s = this.storage;
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

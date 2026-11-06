import { live, retire } from './connections.ts';
import { effectiveAdminEmail, requireProjectManager } from './project-auth.ts';
import { listAll, type StateStorage, type StateTransaction } from './state.ts';
import { accessEnabled, type AccessUser } from './access.ts';
import {
  createEmailGrant,
  emailOperation,
  validateEmailAuth,
  setAccessEmails,
  type EmailGrant,
} from './email.ts';
import { DurableObject } from 'cloudflare:workers';
import {
  dueEntries,
  expireAt,
  requireCurrentExpiry,
  nextExpiry,
} from './expiry.ts';
import { z } from 'zod';
import {
  AppError,
  idSchema,
  accessEmailSchema,
  wakeUrlSchema,
} from '../../../packages/protocol/src/admission.ts';
import {
  body,
  authorizationFailed,
  digest,
  failure,
  json,
  token,
  hostStub,
  type Auth,
  type Env,
} from './common.ts';

type ApiKey = {
  id: string;
  name: string;
  role: 'agent' | 'cli';
  hostId?: string;
  created: number;
};
type Host = {
  id: string;
  name: string;
  disabled: boolean;
  version: 2;
  agentWakeUrl?: string;
  wakeUrlOverride?: string;
  agentAccessEmails?: string[];
  accessEmailsOverride?: string[];
  agentAdminEmail?: string;
  adminEmailOverride?: string;
};
export class RegistryCore {
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}
  private get storage(): StateStorage {
    return this.ctx.storage as unknown as StateStorage;
  }

  private policyReady?: Promise<void>;
  private authorizationVersion = 0;
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
  private async restoreSubscriptions() {
    const policy = await this.policy();
    for (const ws of this.ctx.getWebSockets())
      if (ws.deserializeAttachment()?.policy !== policy)
        retire(ws, 1012, 'Connection policy changed; reconnect');
  }
  private mutations: Promise<unknown> = Promise.resolve();
  async fetch(req: Request): Promise<Response> {
    this.policyReady ??= this.restoreSubscriptions();
    await this.policyReady;
    const op = new URL(req.url).pathname.slice(1);
    if (
      [
        'logout',
        'logoutOthers',
        'credentialRevoke',
        'apiKeyRevoke',
        'setAccessEmails',
        'agentSetAccessEmails',
        'agentSetAdminEmail',
        'setAdminEmail',
        'emailGrantRevoke',
        'emailMigrate',
      ].includes(op)
    ) {
      const result = this.mutations.then(() => this.handleFetch(req));
      this.mutations = result.catch(() => {});
      return result;
    }
    return this.handleFetch(req);
  }
  private async handleFetch(req: Request): Promise<Response> {
    try {
      const op = new URL(req.url).pathname.slice(1);
      await requireCurrentExpiry(this.storage);
      if (op === 'subscribe') return await this.subscribe(req);
      const d = await body(req.clone() as Request);
      const release =
        op === 'releasePublish'
          ? await this.storage.get<any>('release')
          : undefined;
      const previous = [
        'deviceApprove',
        'deviceReject',
        'agentDeviceApprove',
        'agentDeviceReject',
        'managerDevice',
      ].includes(op)
        ? await this.storage.get<any>('device:' + d.id)
        : undefined;
      const credential = [
        'setInstanceName',
        'agentSetWakeUrl',
        'agentSetAccessEmails',
        'agentSetAdminEmail',
      ].includes(op)
        ? await this.storage.get<Auth>('auth:' + (d.hash ?? d.agentHash))
        : undefined;
      const authorizationMutation = [
        'logout',
        'logoutOthers',
        'credentialRevoke',
        'apiKeyRevoke',
        'setAccessEmails',
        'agentSetAccessEmails',
        'agentSetAdminEmail',
        'setAdminEmail',
        'emailGrantRevoke',
        'emailMigrate',
      ].includes(op);
      const invalidation = authorizationMutation
        ? 'auth-change:' + crypto.randomUUID()
        : undefined;
      if (invalidation) {
        this.authorizationVersion++;
        await this.storage.put(invalidation, { until: Date.now() });
        await expireAt(this.storage, invalidation, Date.now());
      }
      const response = await this.dispatch(req);
      if (invalidation) await this.deliverAuthorizationChange(invalidation);
      const mutations = [
        'login',
        'logout',
        'logoutOthers',
        'deviceStart',
        'deviceApprove',
        'deviceReject',
        'agentDeviceApprove',
        'agentDeviceReject',
        'managerDevice',
        'credentialRevoke',
        'apiKeyCreate',
        'apiKeyLogin',
        'apiKeyRevoke',
        'setWakeUrl',
        'agentSetWakeUrl',
        'setAccessEmails',
        'agentSetAccessEmails',
        'agentSetAdminEmail',
        'setAdminEmail',
        'setInstanceName',
        'releasePublish',
        'emailGrantRevoke',
        'emailMigrate',
      ];
      if (
        response.ok &&
        mutations.includes(op) &&
        !(op === 'managerDevice' && d.decision === undefined) &&
        !(
          op === 'releasePublish' &&
          release?.version === d.version &&
          release?.commit === d.commit
        )
      ) {
        const result: any = await response.clone().json();
        const deviceChange = op === 'deviceStart' || previous !== undefined;
        // Administrative state is local to Registry. Only wake hosts whose
        // snapshots changed; release publication is the sole global broadcast.
        const hosts: (string | undefined)[] = deviceChange
          ? [
              op === 'deviceStart'
                ? result.requestedHostId
                : (previous?.requestedHostId ??
                  (op === 'deviceApprove'
                    ? (previous?.hostId ?? d.hostId)
                    : undefined)),
            ]
          : op === 'apiKeyRevoke'
            ? result.map((auth: Auth) => auth.hostId)
            : [
                op === 'credentialRevoke' ||
                op === 'apiKeyLogin' ||
                op === 'emailGrantRevoke' ||
                op === 'emailMigrate'
                  ? result.hostId
                  : op === 'setWakeUrl' ||
                      op === 'setAccessEmails' ||
                      op === 'setAdminEmail'
                    ? d.id
                    : credential?.hostId,
              ];
        await this.publish(
          op === 'releasePublish'
            ? 'release'
            : deviceChange
              ? 'requests'
              : 'registry',
          op === 'deviceStart' ? result.id : previous?.id,
          hosts.filter((id): id is string => typeof id === 'string'),
        ).catch(() =>
          console.log(
            JSON.stringify({
              event: 'notification_deferred',
              scope: 'registry',
            }),
          ),
        );
      }
      return response;
    } catch (error) {
      return failure(error);
    }
  }
  private async subscribe(req: Request) {
    const d = JSON.parse(
      decodeURIComponent(req.headers.get('x-subscription') || '%7B%7D'),
    );
    let attachment: {
      kind: 'owner' | 'device';
      hash?: string;
      id?: string;
      pollHash?: string;
      expires: number;
    };
    if (d.hash) {
      const response = await this.dispatch(
        new Request('https://internal/authHash', {
          method: 'POST',
          body: JSON.stringify({ hash: d.hash }),
        }),
      );
      if (!response.ok) return response;
      const auth = (await response.json()) as Auth;
      if (auth.role !== 'owner')
        throw new AppError(
          'FORBIDDEN',
          'Administrator subscription required',
          403,
        );
      attachment = { kind: 'owner', hash: auth.hash, expires: auth.expires };
    } else {
      const id = idSchema.parse(d.id),
        pollHash = await digest(z.string().max(500).parse(d.secret));
      const request = await this.storage.get<any>('device:' + id);
      if (
        !request ||
        (request.identity && request.identity.accountId !== d.accountId) ||
        request.pollHash !== pollHash ||
        request.expires <= Date.now()
      )
        throw new AppError('UNAUTHORIZED', 'Invalid login subscription', 401);
      attachment = { kind: 'device', id, pollHash, expires: request.expires };
    }
    const policy = await this.policy();
    if (attachment.kind === 'owner') {
      for (;;) {
        const version = this.authorizationVersion;
        const response = await this.dispatch(
          new Request('https://internal/authHash', {
            method: 'POST',
            body: JSON.stringify({ hash: attachment.hash }),
          }),
        );
        if (version !== this.authorizationVersion) continue;
        if (!response.ok) return response;
        break;
      }
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [attachment.kind]);
    pair[1].serializeAttachment({ ...attachment, policy });
    await expireAt(
      this.storage,
      'subscription:' + crypto.randomUUID(),
      attachment.expires,
    );
    const revision = (await this.storage.get('revision')) || 0;
    if (live(pair[1]))
      pair[1].send(JSON.stringify({ type: 'subscribed', revision, demand: 1 }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private async deliverAuthorizationChange(key: string) {
    // A broadcast is intentionally conservative: it also covers cascading A
    // revocation and global administrator changes. Each Host owns its state.
    const hosts = [
      ...(await listAll<Host>(this.storage, { prefix: 'host:' })).values(),
    ];
    const results = await Promise.allSettled(
      hosts.map(async (host) => {
        const response = await hostStub(this.env, host.id).fetch(
          'https://internal/authorization-change',
          {
            method: 'POST',
            headers: { 'x-host': host.id, 'x-coc-authorization-event': key },
          },
        );
        if (!response.ok)
          throw new Error('Authorization invalidation deferred');
      }),
    );
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!live(ws) || a.kind !== 'owner') continue;
      const response = await this.dispatch(
        new Request('https://internal/authHash', {
          method: 'POST',
          body: JSON.stringify({ hash: a.hash }),
        }),
      );
      if (!response.ok)
        retire(
          ws,
          [401, 403].includes(response.status) ? 4001 : 1011,
          'Authorization changed',
        );
    }
    if (results.some((result) => result.status === 'rejected')) {
      // Persist retry before returning; the alarm is independent of packets.
      await this.storage.put(key, { until: Date.now() + 5000 });
      await expireAt(this.storage, key, Date.now() + 5000);
      throw new AppError(
        'INVALIDATION_PENDING',
        'Credentials changed; connection invalidation is pending and will retry',
        503,
      );
    }
    await this.storage.delete(key);
  }
  private async publish(
    scope: string,
    deviceId?: string,
    affectedHosts: string[] = [],
  ) {
    const revision = ((await this.storage.get<number>('revision')) || 0) + 1;
    await this.storage.put('revision', revision);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as {
        kind: string;
        hash?: string;
        id?: string;
        expires: number;
      };
      try {
        if (!live(ws) || (a.kind !== 'owner' && a.id !== deviceId)) continue;
        ws.send(JSON.stringify({ type: 'change', scope, revision }));
      } catch (error) {
        retire(
          ws,
          authorizationFailed(error) ? 4001 : 1011,
          'Subscription validation failed',
        );
      }
    }
    const hosts =
      scope === 'release'
        ? [...(await listAll<Host>(this.storage, { prefix: 'host:' })).values()]
            .filter((h) => h.version === 2 && !h.disabled)
            .map((h) => h.id)
        : [...new Set(affectedHosts)];
    const release =
      scope === 'release'
        ? await this.storage.get<{ version: string }>('release')
        : undefined;
    await Promise.allSettled(
      hosts.map(async (id) => {
        return hostStub(this.env, id).fetch('https://internal/notify', {
          method: 'POST',
          headers: { 'x-host': id },
          body: JSON.stringify({
            scope,
            revision,
            ...(release ? { version: release.version } : {}),
          }),
        });
      }),
    );
    console.log(
      JSON.stringify({
        event: 'registry_change',
        scope,
        revision,
        notifiedHosts: hosts.length,
      }),
    );
  }
  async webSocketMessage(ws: WebSocket) {
    retire(ws, 4000, 'Notification channel is read only');
  }
  async webSocketClose(ws: WebSocket) {
    retire(ws, 1000, 'Closed');
  }
  async webSocketError(ws: WebSocket) {
    retire(ws, 1011, 'Transport error');
  }
  private async dispatch(req: Request) {
    try {
      const d = await body(req),
        op = new URL(req.url).pathname.slice(1),
        s = this.storage;
      if (
        op === 'login' ||
        op === 'deviceStart' ||
        op === 'apiKeyLogin' ||
        op === 'emailAdminLogin'
      ) {
        if (!this.env.OWNER_SECRET || this.env.OWNER_SECRET.length < 32)
          throw new AppError(
            'NOT_CONFIGURED',
            'Owner secret must have at least 32 characters',
            503,
          );
        const key =
          'limit:' +
          (op === 'apiKeyLogin' ? 'api:' : '') +
          String(d.ip).slice(0, 100);
        const attempts = (await s.get<{ count: number; until: number }>(
          key,
        )) || { count: 0, until: Date.now() + 60000 };
        if (attempts.until < Date.now()) {
          attempts.count = 0;
          attempts.until = Date.now() + 60000;
        }
        if (++attempts.count > 10)
          throw new AppError('RATE_LIMITED', 'Try again in one minute', 429);
        await s.put(key, attempts);
        await expireAt(s, key, attempts.until);
      }
      if (
        [
          'emailHosts',
          'emailRestore',
          'emailMigrate',
          'emailAdminLogin',
          'emailGrantRevoke',
        ].includes(op)
      ) {
        const result = await s.transaction((tx) =>
          emailOperation(tx, this.env, op, d),
        );
        if (op === 'emailRestore' || op === 'emailMigrate') {
          const key = 'limit:email:' + d.identity.accountId;
          const limit = await s.get<{ until: number }>(key);
          if (limit) await expireAt(s, key, limit.until);
        }
        if ('hash' in result && result.hash && 'expires' in result)
          await expireAt(s, 'auth:' + result.hash, result.expires);
        return json(result);
      }
      if (op === 'hostRestore') {
        const id = idSchema.parse(d.hostId);
        const name = z.string().trim().min(1).max(100).parse(d.name);
        const value = token(),
          hash = await digest(value);
        await s.transaction(async (tx) => {
          if (await tx.get('host:' + id))
            throw new AppError(
              'HOST_EXISTS',
              'Host identity already exists; existing authorization was preserved',
              409,
            );
          await tx.put('host:' + id, {
            id,
            name,
            version: 2,
            disabled: false,
          } satisfies Host);
          await tx.put('auth:' + hash, {
            hash,
            version: 2,
            role: 'agent',
            name,
            hostId: id,
            created: Date.now(),
            expires: Number.MAX_SAFE_INTEGER,
          } satisfies Auth);
        });
        return json({ hostId: id, token: value, name });
      }
      if (op === 'apiKeyCreate') {
        const role = z.enum(['agent', 'cli']).parse(d.role);
        const name = z.string().trim().min(1).max(100).parse(d.name);
        const value = 'coc_' + token(),
          id = await digest(value);
        const record: ApiKey = { id, role, name, created: Date.now() };
        await s.transaction(async (tx) => {
          if (role === 'cli') {
            record.hostId = idSchema.parse(d.hostId);
            const host = await tx.get<Host>('host:' + record.hostId);
            if (!host || host.version !== 2 || host.disabled)
              throw new AppError(
                'HOST_NOT_FOUND',
                'Unknown or disabled host',
                404,
              );
          }
          await tx.put('apiKey:' + id, record);
          if (role === 'cli')
            await tx.put('auth:' + id, {
              hash: id,
              version: 2,
              role,
              name,
              hostId: record.hostId,
              apiKeyId: id,
              created: record.created,
              expires: Number.MAX_SAFE_INTEGER,
            } satisfies Auth);
        });
        return json({ ...record, apiKey: value });
      }
      if (op === 'apiKeys')
        return json(
          Array.from(
            (await listAll<ApiKey>(s, { prefix: 'apiKey:' })).values(),
          ),
        );
      if (op === 'apiKeyLogin') {
        const id = await digest(z.string().min(1).max(500).parse(d.apiKey));
        const role = z.enum(['agent', 'cli']).parse(d.role);
        const name = z.string().trim().min(1).max(100).parse(d.name);
        return json(
          await s.transaction(async (tx) => {
            const key = await tx.get<ApiKey>('apiKey:' + id);
            if (!key)
              throw new AppError(
                'UNAUTHORIZED',
                'Invalid or revoked API key',
                401,
              );
            if (role !== key.role)
              throw new AppError(
                'FORBIDDEN',
                'API key is restricted to another program',
                403,
              );
            let hostId: string;
            if (role === 'agent')
              hostId = key.hostId || (await this.createHost(tx, name));
            else {
              hostId = idSchema.parse(d.hostId);
              if (hostId !== key.hostId)
                throw new AppError(
                  'FORBIDDEN',
                  'API key is restricted to another host',
                  403,
                );
              const host = await tx.get<Host>('host:' + hostId);
              if (!host || host.version !== 2 || host.disabled)
                throw new AppError('HOST_NOT_FOUND', 'Host unavailable', 404);
            }
            const host = await tx.get<Host>('host:' + hostId);
            if (!host || host.disabled)
              throw new AppError('UNAUTHORIZED', 'Host unavailable', 401);
            if (!key.hostId) {
              key.hostId = hostId;
              await tx.put('apiKey:' + id, key);
              await tx.put('auth:' + id, {
                hash: id,
                version: 2,
                role,
                name,
                hostId,
                apiKeyId: id,
                created: key.created,
                expires: Number.MAX_SAFE_INTEGER,
              } satisfies Auth);
            }
            const auth = await tx.get<Auth>('auth:' + id);
            if (auth) await tx.put('auth:' + id, { ...auth, name });
            if (role === 'agent')
              await tx.put('host:' + hostId, { ...host, name });
            return { hostId, role, name: role === 'agent' ? name : host.name };
          }),
        );
      }
      if (op === 'apiKeyRevoke') {
        const id = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(d.id);
        return json(
          await s.transaction(async (tx) => {
            if (!(await tx.get('apiKey:' + id)))
              throw new AppError('NOT_FOUND', 'Unknown API key', 404);
            const issued = Array.from(
              (await listAll<Auth>(tx, { prefix: 'auth:' })).values(),
            ).filter((a) => a.apiKeyId === id);
            for (const auth of issued)
              await this.revokeCredential(tx, auth.hash);
            await tx.delete('apiKey:' + id);
            return issued;
          }),
        );
      }
      if (op === 'managerDevice') {
        let created: { hash: string; expires: number } | undefined;
        const result = await s.transaction(async (tx) => {
          const key = 'device:' + idSchema.parse(d.id);
          const request = await tx.get<any>(key);
          if (
            !request?.manager ||
            request.role !== 'cli' ||
            request.state !== 'pending' ||
            request.expires <= Date.now()
          )
            throw new AppError(
              'NOT_FOUND',
              'Management pairing request expired or handled',
              404,
            );
          const host = await tx.get<Host>('host:' + request.requestedHostId);
          if (!host || host.disabled)
            throw new AppError('HOST_NOT_FOUND', 'Host unavailable', 404);
          const reviewer: Auth | undefined = await tx.get<Auth>(
            'auth:' + d.reviewerHash,
          );
          if (!reviewer || reviewer.expires <= Date.now())
            throw new AppError('UNAUTHORIZED', 'Login required', 401);
          await requireProjectManager(this.env, reviewer, host);
          if (d.decision === undefined)
            return {
              id: request.id,
              name: request.name,
              code: request.code,
              hostId: host.id,
              hostName: host.name,
              expires: request.expires,
            };
          if (d.decision !== 'approve' && d.decision !== 'reject')
            throw new AppError('INVALID_REQUEST', 'Invalid decision', 400);
          if (d.code !== request.code)
            throw new AppError('FORBIDDEN', 'Pairing code mismatch', 403);
          if (d.decision === 'reject') request.state = 'rejected';
          else {
            const value = token(),
              hash = await digest(value);
            const manager: NonNullable<Auth['manager']> =
              reviewer.role === 'owner'
                ? {
                    kind: 'owner',
                    ownerVersion: reviewer.ownerVersion,
                    ownerSource: reviewer.ownerSource,
                    adminEmailVersion: reviewer.adminEmailVersion,
                  }
                : {
                    kind: 'email',
                    email: reviewer.email,
                    accountId: reviewer.accountId,
                  };
            created = { hash, expires: Date.now() + 30 * 86400000 };
            await tx.put('auth:' + hash, {
              hash,
              role: 'cli',
              version: 2,
              name: request.name,
              hostId: host.id,
              created: Date.now(),
              expires: created.expires,
              manager,
            } satisfies Auth);
            request.hostId = host.id;
            request.state = 'approved';
            request.result = {
              token: value,
              hostId: host.id,
              role: 'cli',
              name: request.name,
            };
          }
          await tx.put(key, request);
          return { ok: true };
        });
        if (created) await expireAt(s, 'auth:' + created.hash, created.expires);
        return json(result);
      }
      if (op === 'managerDeviceHost') {
        const request = await s.get<any>('device:' + idSchema.parse(d.id));
        if (
          !request?.manager ||
          request.state !== 'pending' ||
          request.expires <= Date.now()
        )
          throw new AppError(
            'NOT_FOUND',
            'Management pairing request expired or handled',
            404,
          );
        return json({ hostId: request.requestedHostId });
      }
      if (op === 'deviceStart') {
        const role = z.enum(['agent', 'cli', 'web']).parse(d.role);
        const name = z.string().trim().min(1).max(100).parse(d.name);
        // This header is set only by the internal registry caller, never forwarded from clients.
        const emailRequired =
          accessEnabled(this.env) &&
          req.headers.get('x-coc-email-auth') !== 'optional';
        const identity: AccessUser | undefined =
          role === 'web' && emailRequired ? d.identity : undefined;
        if (role === 'web' && emailRequired && !identity)
          throw new AppError(
            'ACCESS_USER_REQUIRED',
            'Verified email required',
            403,
          );
        const manager = z.boolean().default(false).parse(d.manager);
        if (manager && (role !== 'cli' || !d.requestedHostId))
          throw new AppError(
            'INVALID_REQUEST',
            'Manager login requires a targeted CLI request',
            400,
          );
        const hostId = role === 'agent' ? crypto.randomUUID() : undefined;
        const requestedHostId =
          d.requestedHostId === undefined
            ? undefined
            : idSchema.parse(d.requestedHostId);
        if (requestedHostId !== undefined) {
          if (role === 'agent')
            throw new AppError(
              'INVALID_REQUEST',
              'Only clients can select a target',
              400,
            );
          const host = await s.get<Host>('host:' + requestedHostId);
          if (!host || host.version !== 2 || host.disabled)
            throw new AppError('HOST_NOT_FOUND', 'Host unavailable', 404);
        }
        const message =
          role !== 'agent'
            ? z.string().trim().max(1000).default('').parse(d.message)
            : undefined;
        const id = crypto.randomUUID(),
          pollSecret = token();
        const request = {
          id,
          role,
          name,
          hostId,
          requestedHostId,
          message,
          code: id.slice(0, 8).toUpperCase(),
          identity,
          email: identity?.email,
          manager,
          pollHash: await digest(pollSecret),
          expires: Date.now() + 5 * 60000,
          state: 'pending',
        };
        await s.put('device:' + id, request);
        await expireAt(s, 'device:' + id, request.expires);
        return json({
          id,
          pollSecret,
          code: request.code,
          expires: request.expires,
          hostId,
          requestedHostId,
          url: manager ? '/#manager=' + id : '/#authorize=' + id,
          manager,
        });
      }
      if (op === 'agentDevices') {
        return json(
          await s.transaction(async (tx) => {
            const agent = await this.approvingAgent(tx, d.agentHash);
            const pending = Array.from(
              (await listAll<any>(tx, { prefix: 'device:' })).values(),
            )
              .filter(
                (request) =>
                  ['cli', 'web'].includes(request.role) &&
                  request.requestedHostId === agent.hostId &&
                  request.state === 'pending' &&
                  request.expires > Date.now(),
              )
              .map(
                ({
                  id,
                  role,
                  name,
                  requestedHostId,
                  message,
                  manager,
                  email,
                  code,
                  expires,
                }) => ({
                  id,
                  role,
                  name,
                  requestedHostId,
                  message,
                  manager,
                  email,
                  code,
                  expires,
                }),
              );
            return { hostId: agent.hostId, pending };
          }),
        );
      }
      if (op === 'devices') {
        const pending = Array.from(
          (await listAll<any>(s, { prefix: 'device:' })).values(),
        )
          .filter((v) => v.expires > Date.now() && v.state === 'pending')
          .map(
            ({
              id,
              role,
              name,
              hostId,
              requestedHostId,
              message,
              manager,
              email,
              code,
              expires,
            }) => ({
              id,
              role,
              name,
              hostId,
              requestedHostId,
              message,
              manager,
              email,
              code,
              expires,
            }),
          );
        const credentials = Array.from(
          (await listAll<Auth>(s, { prefix: 'auth:' })).values(),
        )
          .filter((v) => v.version === 2 && v.role !== 'owner' && !v.grantId)
          .map(
            ({
              hash,
              role,
              name,
              hostId,
              created,
              lastSeen,
              email,
              manager,
              expires,
            }) => ({
              id: hash,
              lastSeen,
              email: manager?.email ?? email,
              manager: manager?.kind,
              expires: manager ? expires : undefined,
              role,
              name,
              hostId,
              created,
            }),
          );
        for (const grant of (
          await listAll<EmailGrant>(s, { prefix: 'emailGrant:' })
        ).values())
          if (grant.active)
            credentials.push({
              id: grant.id,
              manager: undefined,
              expires: undefined,
              role: 'web',
              name: grant.email,
              lastSeen: grant.lastSeen,
              email: grant.email,
              hostId: grant.hostId,
              created: grant.created,
            });
        return json({ pending, credentials });
      }
      if (
        [
          'deviceApprove',
          'deviceReject',
          'agentDeviceApprove',
          'agentDeviceReject',
        ].includes(op)
      ) {
        const byAgent = op.startsWith('agent');
        const key = 'device:' + idSchema.parse(d.id);
        await s.transaction(async (tx) => {
          const agent = byAgent
            ? await this.approvingAgent(tx, d.agentHash)
            : undefined;
          const request = await tx.get<any>(key);
          if (
            agent &&
            (!request ||
              !['cli', 'web'].includes(request.role) ||
              request.requestedHostId !== agent.hostId)
          )
            throw new AppError(
              'FORBIDDEN',
              'Request is not explicitly addressed to this Agent',
              403,
            );
          if (
            !request ||
            request.expires <= Date.now() ||
            request.state !== 'pending'
          )
            throw new AppError(
              'INVALID_REQUEST',
              'Request expired or already handled',
              409,
            );
          if (
            request.manager &&
            (op === 'deviceApprove' || op === 'agentDeviceApprove')
          )
            throw new AppError(
              'FORBIDDEN',
              'Use the administrator identity pairing page for manager login',
              403,
            );
          if (op === 'deviceReject' || op === 'agentDeviceReject')
            request.state = 'rejected';
          else {
            if (request.role !== 'agent') {
              if (
                request.requestedHostId !== undefined &&
                d.hostId !== undefined &&
                d.hostId !== request.requestedHostId
              )
                throw new AppError(
                  'FORBIDDEN',
                  'The requested target cannot be changed',
                  403,
                );
              request.hostId =
                agent?.hostId ??
                request.requestedHostId ??
                idSchema.parse(d.hostId);
            }
            if (request.role === 'agent') {
              await this.createHost(tx, request.name, request.hostId);
            } else {
              const host = await tx.get<Host>('host:' + request.hostId);
              if (!host || host.version !== 2 || host.disabled)
                throw new AppError('HOST_NOT_FOUND', 'Host unavailable', 404);
            }
            const value = token(),
              hash = await digest(value);
            await tx.put('auth:' + hash, {
              hash,
              version: 2,
              role: request.role,
              name: request.name,
              hostId: request.hostId,
              created: Date.now(),
              expires: Number.MAX_SAFE_INTEGER,
            } satisfies Auth);
            request.approvedBy = agent?.hash ?? d.approvedBy;
            request.state = 'approved';
            request.result = {
              token: value,
              hostId: request.hostId,
              name: request.name,
              role: request.role,
            };
          }
          await tx.put(key, request);
        });
        return json({ ok: true });
      }
      if (op === 'devicePoll') {
        const key = 'device:' + idSchema.parse(d.id);
        const hash = await digest(z.string().max(500).parse(d.pollSecret));
        return json(
          await s.transaction(async (tx) => {
            const request = await tx.get<any>(key);
            if (
              !request ||
              request.expires <= Date.now() ||
              request.pollHash !== hash
            )
              throw new AppError(
                'UNAUTHORIZED',
                'Invalid or expired login request',
                401,
              );
            if (
              request.identity &&
              request.identity.accountId !== d.identity?.accountId
            )
              throw new AppError(
                'FORBIDDEN',
                'Email does not match the pairing request',
                403,
              );
            if (d.web !== (request.role === 'web'))
              throw new AppError('FORBIDDEN', 'Wrong login transport', 403);
            if (request.state === 'pending') return { state: 'pending' };
            // Native polls can lose a successful response. Keep the same grant
            // recoverable with its secret until the original request expires.
            // Browser cookie delivery retains its single-use semantics.
            if (request.role === 'web') await tx.delete(key);
            if (request.state === 'rejected') return { state: 'rejected' };
            const auth = await tx.get<Auth>(
              'auth:' + (await digest(request.result.token)),
            );
            const host = await tx.get<Host>('host:' + request.hostId);
            if (!auth || !host || host.version !== 2 || host.disabled)
              throw new AppError('UNAUTHORIZED', 'Authorization revoked', 401);
            if (request.identity) {
              const grant = await createEmailGrant(
                tx,
                request.identity,
                request.hostId,
                request.approvedBy,
              );
              Object.assign(auth, {
                accountId: grant.accountId,
                email: grant.email,
                grantId: grant.generation,
              });
              await tx.put('auth:' + auth.hash, auth);
            }
            if (request.role !== 'web') {
              request.delivered = true;
              await tx.put(key, request);
            }
            return { state: 'approved', ...request.result };
          }),
        );
      }
      if (op === 'credentialRevoke') {
        const hash = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(d.id);
        return json(
          await s.transaction(async (tx) => {
            const auth = await this.revokeCredential(tx, hash);
            if (!auth)
              throw new AppError('NOT_FOUND', 'Unknown device credential', 404);
            return auth;
          }),
        );
      }
      if (op === 'releasePublish') {
        const version = z
          .string()
          .regex(/^\d+\.\d+\.\d+$/)
          .parse(d.version);
        const commit = z
          .string()
          .regex(/^[a-f0-9]{40}$/)
          .parse(d.commit);
        const previous = await s.get<any>('release');
        if (previous?.version === version && previous.commit !== commit)
          throw new AppError(
            'IDEMPOTENCY_CONFLICT',
            'Version already published from another commit',
            409,
          );
        if (previous?.version === version) return json(previous);
        await s.put('release', { version, commit });
        return json({ version, commit });
      }
      if (op === 'login') {
        if (
          typeof d.secret !== 'string' ||
          (await digest(d.secret)) !== (await digest(this.env.OWNER_SECRET))
        )
          throw new AppError('UNAUTHORIZED', 'Invalid login', 401);
        const value = token(),
          hash = await digest(value),
          expires = Date.now() + 8 * 3600000;
        await s.put('auth:' + hash, {
          hash,
          role: 'owner',
          version: 2,
          name: 'Administrator',
          ownerVersion: await digest(this.env.OWNER_SECRET),
          ...(d.identity
            ? {
                accountId: d.identity.accountId,
                email: d.identity.email,
                ownerSource: 'secret' as const,
              }
            : {}),
          created: Date.now(),
          expires,
        } satisfies Auth);
        await expireAt(s, 'auth:' + hash, expires);
        return json({ token: value, expires });
      }
      if (op === 'auth' || op === 'authHash' || op === 'authHost') {
        const hash =
          op !== 'authHash'
            ? await digest(z.string().max(500).parse(d.token))
            : z.string().parse(d.hash);
        return json(
          await s.transaction(async (tx) => {
            const a = await tx.get<Auth>('auth:' + hash);
            if (!a || a.version !== 2 || a.expires <= Date.now())
              throw new AppError(
                'UNAUTHORIZED',
                'Expired or invalid credentials',
                401,
              );
            if (
              a.role === 'owner' &&
              a.ownerVersion !== (await digest(this.env.OWNER_SECRET))
            )
              throw new AppError(
                'UNAUTHORIZED',
                'Administrator secret rotated; log in again',
                401,
              );
            await validateEmailAuth(tx, this.env, a);
            if (a.manager) {
              const host = await tx.get<Host>('host:' + a.hostId);
              if (!host || host.disabled)
                throw new AppError('UNAUTHORIZED', 'Host unavailable', 401);
              await requireProjectManager(this.env, a, host);
            }
            if (a.apiKeyId && !(await tx.get('apiKey:' + a.apiKeyId)))
              throw new AppError('UNAUTHORIZED', 'API key revoked', 401);
            if (a.hostId) {
              const h = await tx.get<Host>('host:' + a.hostId);
              if (!h || h.version !== 2 || h.disabled)
                throw new AppError('UNAUTHORIZED', 'Device disabled', 401);
            }
            const now = Date.now();
            if (
              a.role !== 'owner' &&
              (a.lastSeen === undefined || now - a.lastSeen >= 60000)
            ) {
              a.lastSeen = now;
              await tx.put('auth:' + hash, a);
              if (a.grantId) {
                const key = `emailGrant:${a.accountId}:${a.hostId}`;
                const grant = await tx.get<EmailGrant>(key);
                if (grant?.active && grant.generation === a.grantId)
                  await tx.put(key, { ...grant, lastSeen: now });
              }
            }
            return op === 'authHost'
              ? { ...a, host: await tx.get<Host>('host:' + a.hostId) }
              : a;
          }),
        );
      }
      if (op === 'setInstanceName') {
        const name = z
          .string()
          .trim()
          .min(1)
          .max(100)
          .refine(
            (name) =>
              !Array.from(name).some(
                (character) =>
                  character.charCodeAt(0) < 32 ||
                  character.charCodeAt(0) === 127,
              ),
          )
          .parse(d.displayName);
        const hash = z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(d.hash);
        return json(
          await s.transaction(async (tx) => {
            const auth = await tx.get<Auth>('auth:' + hash);
            if (
              !auth ||
              auth.version !== 2 ||
              auth.expires <= Date.now() ||
              !['agent', 'cli'].includes(auth.role) ||
              (auth.apiKeyId && !(await tx.get('apiKey:' + auth.apiKeyId)))
            )
              throw new AppError(
                'UNAUTHORIZED',
                'Invalid native credential',
                401,
              );
            const host = await tx.get<Host>('host:' + auth.hostId);
            if (!host || host.version !== 2 || host.disabled)
              throw new AppError('UNAUTHORIZED', 'Host unavailable', 401);
            await tx.put('auth:' + hash, { ...auth, name });
            if (auth.role === 'agent')
              await tx.put('host:' + host.id, { ...host, name });
            return { displayName: name };
          }),
        );
      }
      if (op === 'logoutOthers') {
        for (const [key, auth] of await listAll<Auth>(s, { prefix: 'auth:' }))
          if (auth.role === 'owner' && auth.hash !== d.hash)
            await s.delete(key);
        return json({ ok: true });
      }
      if (op === 'logout') {
        await s.delete('auth:' + d.hash);
        return json({ ok: true });
      }
      if (op === 'setAdminEmail' || op === 'agentSetAdminEmail') {
        return json(
          await s.transaction(async (tx) => {
            const agent =
              op === 'agentSetAdminEmail'
                ? await this.approvingAgent(tx, d.agentHash)
                : undefined;
            const id = agent?.hostId ?? idSchema.parse(d.id);
            const host = await tx.get<Host>('host:' + id);
            if (!host || host.disabled)
              throw new AppError('HOST_NOT_FOUND', 'Host unavailable', 404);
            if (!agent && d.email === null) delete host.adminEmailOverride;
            else
              host[agent ? 'agentAdminEmail' : 'adminEmailOverride'] =
                d.email === '' ? '' : accessEmailSchema.parse(d.email);
            await tx.put('host:' + id, host);
            // Revalidate association grants against the combined access/admin email admission.
            await setAccessEmails(
              tx,
              this.env,
              id,
              host.agentAccessEmails ?? [],
              true,
            );
            return { hostId: id, adminEmail: effectiveAdminEmail(host) };
          }),
        );
      }
      if (op === 'setAccessEmails' || op === 'agentSetAccessEmails') {
        return json(
          await s.transaction(async (tx) => {
            const agent =
              op === 'agentSetAccessEmails'
                ? await this.approvingAgent(tx, d.agentHash)
                : undefined;
            return setAccessEmails(
              tx,
              this.env,
              agent ? agent.hostId! : idSchema.parse(d.id),
              d.emails,
              !!agent,
            );
          }),
        );
      }
      if (op === 'setWakeUrl' || op === 'agentSetWakeUrl') {
        return json(
          await s.transaction(async (tx) => {
            const agent =
              op === 'agentSetWakeUrl'
                ? await this.approvingAgent(tx, d.agentHash)
                : undefined;
            const id = agent ? agent.hostId! : idSchema.parse(d.id);
            const h = await tx.get<Host>('host:' + id);
            if (!h || h.version !== 2 || h.disabled)
              throw new AppError(
                'HOST_NOT_FOUND',
                'Unknown or disabled host',
                404,
              );
            if (!agent && d.wakeUrl === null) delete h.wakeUrlOverride;
            else {
              const value = wakeUrlSchema.parse(d.wakeUrl);
              if (agent) h.agentWakeUrl = value;
              else h.wakeUrlOverride = value;
            }
            await tx.put('host:' + id, h);
            return { ok: true };
          }),
        );
      }
      if (op === 'hosts')
        return json(
          Array.from(
            (await listAll<Host>(s, { prefix: 'host:' })).values(),
          ).filter((host) => host.version === 2),
        );
      if (op === 'host') {
        const h = await s.get<Host>('host:' + idSchema.parse(d.id));
        if (!h || h.version !== 2 || h.disabled)
          throw new AppError('HOST_NOT_FOUND', 'Unknown or disabled host', 404);
        return json(h);
      }
      throw new AppError('NOT_FOUND', 'Unknown operation', 404);
    } catch (e) {
      return failure(e);
    }
  }
  private async approvingAgent(tx: StateTransaction, hash: unknown) {
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse(hash);
    const agent = await tx.get<Auth>('auth:' + id);
    if (
      !agent ||
      agent.version !== 2 ||
      agent.expires <= Date.now() ||
      (agent.apiKeyId && !(await tx.get('apiKey:' + agent.apiKeyId)))
    )
      throw new AppError(
        'UNAUTHORIZED',
        'Agent authorization revoked or expired',
        401,
      );
    if (agent.role !== 'agent' || !agent.hostId)
      throw new AppError('FORBIDDEN', 'Agent credential required', 403);
    const host = await tx.get<Host>('host:' + agent.hostId);
    if (!host || host.version !== 2 || host.disabled)
      throw new AppError('UNAUTHORIZED', 'Agent unavailable', 401);
    return agent;
  }
  private async createHost(
    tx: StateTransaction,
    name: string,
    id = crypto.randomUUID(),
  ) {
    await tx.put('host:' + id, {
      id,
      name,
      disabled: false,
      version: 2,
    } satisfies Host);
    return id;
  }
  private async revokeCredential(tx: StateTransaction, hash: string) {
    const auth = await tx.get<Auth>('auth:' + hash);
    if (!auth || auth.role === 'owner') return undefined;
    await tx.delete('auth:' + hash);
    if (auth.apiKeyId) await tx.delete('apiKey:' + auth.apiKeyId);
    if (auth.role === 'agent') {
      const host = await tx.get<Host>('host:' + auth.hostId);
      if (host) await tx.put('host:' + host.id, { ...host, disabled: true });
      for (const [key, value] of await listAll<Auth>(tx, { prefix: 'auth:' }))
        if (value.hostId === auth.hostId) await tx.delete(key);
      for (const [key, grant] of await listAll<EmailGrant>(tx, {
        prefix: 'emailGrant:',
      }))
        if (grant.hostId === auth.hostId && grant.active)
          await tx.put(key, { ...grant, active: false, revoked: Date.now() });
      // CC login keys cannot be reused after their target A is revoked.
      for (const [key, value] of await listAll<ApiKey>(tx, {
        prefix: 'apiKey:',
      }))
        if (value.hostId === auth.hostId) await tx.delete(key);
    }
    return auth;
  }
  async alarm() {
    this.policyReady ??= this.restoreSubscriptions();
    await this.policyReady;
    await this.mutations;
    const s = this.storage;
    await requireCurrentExpiry(s);
    for (const [index, { key }] of await dueEntries(s)) {
      if (key.startsWith('auth-change:')) {
        const pending = await s.get<{ until: number }>(key);
        if (!pending || pending.until > Date.now()) {
          await s.delete(index);
          continue;
        }
        try {
          await this.deliverAuthorizationChange(key);
        } catch {
          await s.put(key, { until: Date.now() + 5000 });
          await expireAt(s, key, Date.now() + 5000);
        }
        await s.delete(index);
        continue;
      }
      let deviceId: string | undefined;
      let hostId: string | undefined;
      await s.transaction(async (tx) => {
        const value = await tx.get<any>(key);
        if (!value || (value.expires ?? value.until) > Date.now()) return;
        if (value.result && !value.delivered) {
          const at = Date.now();
          const event = 'auth-change:' + crypto.randomUUID();
          await tx.put(event, { until: at });
          await tx.put(`due:${String(at).padStart(16, '0')}:${event}`, {
            key: event,
            at,
          });
          await this.revokeCredential(tx, await digest(value.result.token));
        }
        await tx.delete(key);
        if (key.startsWith('device:')) {
          deviceId = key.slice(7);
          hostId =
            value.requestedHostId ?? (value.result ? value.hostId : undefined);
        }
      });
      await s.delete(index);
      if (deviceId)
        await this.publish('requests', deviceId, hostId ? [hostId] : []);
    }
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment().expires <= Date.now())
        retire(ws, 4001, 'Subscription expired');
    }
    await nextExpiry(s);
  }
}

export class RegistryDO extends DurableObject<Env> {
  private core?: RegistryCore;
  private preparing?: Promise<void>;
  private prepare() {
    if (this.core) return Promise.resolve();
    return (this.preparing ??= nextExpiry(
      this.ctx.storage as unknown as StateStorage,
    )
      .then(() => {
        this.core = new RegistryCore(this.ctx, this.env);
      })
      .catch((error) => {
        this.preparing = undefined;
        throw error;
      }));
  }
  async fetch(req: Request) {
    try {
      await this.prepare();
      return await this.core!.fetch(req);
    } catch (error) {
      return failure(error);
    }
  }
  async alarm() {
    await this.prepare();
    await this.core!.alarm();
  }
  async webSocketMessage(ws: WebSocket) {
    retire(ws, 4000, 'Notification channel is read only');
  }
  async webSocketClose(ws: WebSocket) {
    retire(ws, 1000, 'Closed');
  }
  async webSocketError(ws: WebSocket) {
    retire(ws, 1011, 'Transport error');
  }
}

import { accessEnabled, type AccessUser } from './access.ts';
import {
  createEmailGrant,
  emailOperation,
  validateEmailAuth,
  type EmailGrant,
} from './email.ts';
import { DurableObject } from 'cloudflare:workers';
import { dueEntries, expireAt, migrateExpiry, nextExpiry } from './expiry.ts';
import { z } from 'zod';
import {
  AppError,
  idSchema,
  wakeUrlSchema,
} from '../../../packages/protocol/src/index.ts';
import {
  body,
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
};
export class RegistryDO extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    try {
      const op = new URL(req.url).pathname.slice(1);
      if (op === 'subscribe') return await this.subscribe(req);
      await migrateExpiry(this.ctx.storage, ['device:', 'limit:', 'auth:']);
      const d = await body(req.clone() as Request);
      const release =
        op === 'releasePublish'
          ? await this.ctx.storage.get<any>('release')
          : undefined;
      const previous = [
        'deviceApprove',
        'deviceReject',
        'agentDeviceApprove',
        'agentDeviceReject',
      ].includes(op)
        ? await this.ctx.storage.get<any>('device:' + d.id)
        : undefined;
      const credential = ['setInstanceName', 'agentSetWakeUrl'].includes(op)
        ? await this.ctx.storage.get<Auth>('auth:' + (d.hash ?? d.agentHash))
        : undefined;
      const response = await this.dispatch(req);
      const mutations = [
        'login',
        'logout',
        'logoutOthers',
        'deviceStart',
        'deviceApprove',
        'deviceReject',
        'agentDeviceApprove',
        'agentDeviceReject',
        'credentialRevoke',
        'apiKeyCreate',
        'apiKeyLogin',
        'apiKeyRevoke',
        'setWakeUrl',
        'agentSetWakeUrl',
        'setInstanceName',
        'releasePublish',
        'emailGrantRevoke',
        'emailMigrate',
      ];
      if (
        response.ok &&
        mutations.includes(op) &&
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
                  : op === 'setWakeUrl'
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
      const request = await this.ctx.storage.get<any>('device:' + id);
      if (
        !request ||
        (request.identity && request.identity.accountId !== d.accountId) ||
        request.pollHash !== pollHash ||
        request.expires <= Date.now()
      )
        throw new AppError('UNAUTHORIZED', 'Invalid login subscription', 401);
      attachment = { kind: 'device', id, pollHash, expires: request.expires };
    }
    if (this.ctx.getWebSockets().length >= 240)
      throw new AppError(
        'CAPACITY',
        'Notification connection budget exhausted',
        429,
      );
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [attachment.kind]);
    pair[1].serializeAttachment(attachment);
    pair[1].send(
      JSON.stringify({
        type: 'subscribed',
        revision: (await this.ctx.storage.get('revision')) || 0,
        demand: 1,
      }),
    );
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  private async publish(
    scope: string,
    deviceId?: string,
    affectedHosts: string[] = [],
  ) {
    const revision =
      ((await this.ctx.storage.get<number>('revision')) || 0) + 1;
    await this.ctx.storage.put('revision', revision);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as {
        kind: string;
        hash?: string;
        id?: string;
        expires: number;
      };
      try {
        if (a.expires <= Date.now()) {
          ws.close(4001, 'Subscription expired');
          continue;
        }
        if (a.kind === 'owner') {
          const auth = await this.dispatch(
            new Request('https://internal/authHash', {
              method: 'POST',
              body: JSON.stringify({ hash: a.hash }),
            }),
          );
          if (!auth.ok) {
            ws.close(4001, 'Authorization revoked');
            continue;
          }
        } else if (a.id !== deviceId) continue;
        ws.send(JSON.stringify({ type: 'change', scope, revision }));
      } catch {
        ws.close(4001, 'Subscription validation failed');
      }
    }
    const hosts =
      scope === 'release'
        ? [...(await this.ctx.storage.list<Host>({ prefix: 'host:' })).values()]
            .filter((h) => h.version === 2 && !h.disabled)
            .map((h) => h.id)
        : [...new Set(affectedHosts)];
    const release =
      scope === 'release'
        ? await this.ctx.storage.get<{ version: string }>('release')
        : undefined;
    await Promise.allSettled(
      hosts.map(async (id) =>
        hostStub(this.env, id).fetch('https://internal/notify', {
          method: 'POST',
          body: JSON.stringify({
            scope,
            revision,
            ...(release ? { version: release.version } : {}),
          }),
        }),
      ),
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
    ws.close(4000, 'Notification channel is read only');
  }
  async webSocketClose(ws: WebSocket) {
    ws.close(1000, 'Closed');
  }
  async webSocketError(ws: WebSocket) {
    ws.close(1011, 'Transport error');
  }
  private async dispatch(req: Request) {
    try {
      const d = await body(req),
        op = new URL(req.url).pathname.slice(1),
        s = this.ctx.storage;
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
          Array.from((await s.list<ApiKey>({ prefix: 'apiKey:' })).values()),
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
              (await tx.list<Auth>({ prefix: 'auth:' })).values(),
            ).filter((a) => a.apiKeyId === id);
            for (const auth of issued)
              await this.revokeCredential(tx, auth.hash);
            await tx.delete('apiKey:' + id);
            return issued;
          }),
        );
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
        if ((await s.list({ prefix: 'device:' })).size >= 200)
          throw new AppError('CAPACITY', 'Too many pending requests', 429);
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
          url: '/#authorize=' + id,
        });
      }
      if (op === 'agentDevices') {
        return json(
          await s.transaction(async (tx) => {
            const agent = await this.approvingAgent(tx, d.agentHash);
            const pending = Array.from(
              (await tx.list<any>({ prefix: 'device:' })).values(),
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
                  email,
                  code,
                  expires,
                }) => ({
                  id,
                  role,
                  name,
                  requestedHostId,
                  message,
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
          (await s.list<any>({ prefix: 'device:' })).values(),
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
              email,
              code,
              expires,
            }),
          );
        const credentials = Array.from(
          (await s.list<Auth>({ prefix: 'auth:' })).values(),
        )
          .filter((v) => v.version === 2 && v.role !== 'owner' && !v.grantId)
          .map(({ hash, role, name, hostId, created }) => ({
            id: hash,
            role,
            name,
            hostId,
            created,
          }));
        for (const grant of (
          await s.list<EmailGrant>({ prefix: 'emailGrant:' })
        ).values())
          if (grant.active)
            credentials.push({
              id: grant.id,
              role: 'web',
              name: grant.email,
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
        const a = await s.get<Auth>('auth:' + hash);
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
        await validateEmailAuth(s, this.env, a);
        if (a.apiKeyId && !(await s.get('apiKey:' + a.apiKeyId)))
          throw new AppError('UNAUTHORIZED', 'API key revoked', 401);
        if (a.hostId) {
          const h = await s.get<Host>('host:' + a.hostId);
          if (!h || h.version !== 2 || h.disabled)
            throw new AppError('UNAUTHORIZED', 'Device disabled', 401);
        }
        return json(
          op === 'authHost'
            ? { ...a, host: await s.get<Host>('host:' + a.hostId) }
            : a,
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
        for (const [key, auth] of await s.list<Auth>({ prefix: 'auth:' }))
          if (auth.role === 'owner' && auth.hash !== d.hash)
            await s.delete(key);
        return json({ ok: true });
      }
      if (op === 'logout') {
        await s.delete('auth:' + d.hash);
        return json({ ok: true });
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
          Array.from((await s.list<Host>({ prefix: 'host:' })).values()).filter(
            (host) => host.version === 2,
          ),
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
  private async approvingAgent(tx: DurableObjectTransaction, hash: unknown) {
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
    tx: DurableObjectTransaction,
    name: string,
    id = crypto.randomUUID(),
  ) {
    const hosts = Array.from(
      (await tx.list<Host>({ prefix: 'host:' })).values(),
    );
    if (hosts.filter((h) => h.version === 2 && !h.disabled).length >= 5)
      throw new AppError('CAPACITY', 'At most five registered hosts', 409);
    await tx.put('host:' + id, {
      id,
      name,
      disabled: false,
      version: 2,
    } satisfies Host);
    return id;
  }
  private async revokeCredential(tx: DurableObjectTransaction, hash: string) {
    const auth = await tx.get<Auth>('auth:' + hash);
    if (!auth || auth.role === 'owner') return undefined;
    await tx.delete('auth:' + hash);
    if (auth.apiKeyId) await tx.delete('apiKey:' + auth.apiKeyId);
    if (auth.role === 'agent') {
      const host = await tx.get<Host>('host:' + auth.hostId);
      if (host) await tx.put('host:' + host.id, { ...host, disabled: true });
      for (const [key, value] of await tx.list<Auth>({ prefix: 'auth:' }))
        if (value.hostId === auth.hostId) await tx.delete(key);
      for (const [key, grant] of await tx.list<EmailGrant>({
        prefix: 'emailGrant:',
      }))
        if (grant.hostId === auth.hostId && grant.active)
          await tx.put(key, { ...grant, active: false, revoked: Date.now() });
      // CC login keys cannot be reused after their target A is revoked.
      for (const [key, value] of await tx.list<ApiKey>({ prefix: 'apiKey:' }))
        if (value.hostId === auth.hostId) await tx.delete(key);
    }
    return auth;
  }
  async alarm() {
    const s = this.ctx.storage;
    await migrateExpiry(s, ['device:', 'limit:', 'auth:']);
    for (const [index, { key }] of await dueEntries(s)) {
      let deviceId: string | undefined;
      let hostId: string | undefined;
      await s.transaction(async (tx) => {
        const value = await tx.get<any>(key);
        if (!value || (value.expires ?? value.until) > Date.now()) return;
        if (value.result && !value.delivered) {
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
        ws.close(4001, 'Subscription expired');
    }
    await nextExpiry(s);
  }
}

import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { AppError, idSchema } from '../../../packages/protocol/src/index.ts';
import {
  body,
  digest,
  failure,
  json,
  token,
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
type Host = { id: string; name: string; disabled: boolean; version: 2 };
export class RegistryDO extends DurableObject<Env> {
  async fetch(req: Request) {
    try {
      const d = await body(req),
        op = new URL(req.url).pathname.slice(1),
        s = this.ctx.storage;
      if (op === 'login' || op === 'deviceStart' || op === 'apiKeyLogin') {
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
        await this.schedule();
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
            return { hostId, role, name: host.name };
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
          pollHash: await digest(pollSecret),
          expires: Date.now() + 5 * 60000,
          state: 'pending',
        };
        await s.put('device:' + id, request);
        await this.schedule();
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
                  code,
                  expires,
                }) => ({
                  id,
                  role,
                  name,
                  requestedHostId,
                  message,
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
              code,
              expires,
            }) => ({
              id,
              role,
              name,
              hostId,
              requestedHostId,
              message,
              code,
              expires,
            }),
          );
        const credentials = Array.from(
          (await s.list<Auth>({ prefix: 'auth:' })).values(),
        )
          .filter((v) => v.version === 2 && v.role !== 'owner')
          .map(({ hash, role, name, hostId, created }) => ({
            id: hash,
            role,
            name,
            hostId,
            created,
          }));
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
            if (d.web !== (request.role === 'web'))
              throw new AppError('FORBIDDEN', 'Wrong login transport', 403);
            if (request.state === 'pending') return { state: 'pending' };
            await tx.delete(key);
            if (request.state === 'rejected') return { state: 'rejected' };
            const auth = await tx.get<Auth>(
              'auth:' + (await digest(request.result.token)),
            );
            const host = await tx.get<Host>('host:' + request.hostId);
            if (!auth || !host || host.version !== 2 || host.disabled)
              throw new AppError('UNAUTHORIZED', 'Authorization revoked', 401);
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
          created: Date.now(),
          expires,
        } satisfies Auth);
        return json({ token: value, expires });
      }
      if (op === 'auth' || op === 'authHash') {
        const hash =
          op === 'auth'
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
        if (a.apiKeyId && !(await s.get('apiKey:' + a.apiKeyId)))
          throw new AppError('UNAUTHORIZED', 'API key revoked', 401);
        if (a.hostId) {
          const h = await s.get<Host>('host:' + a.hostId);
          if (!h || h.version !== 2 || h.disabled)
            throw new AppError('UNAUTHORIZED', 'Device disabled', 401);
        }
        return json(a);
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
      if (op === 'hosts')
        return json(
          Array.from((await s.list<Host>({ prefix: 'host:' })).values()),
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
      // CC login keys cannot be reused after their target A is revoked.
      for (const [key, value] of await tx.list<ApiKey>({ prefix: 'apiKey:' }))
        if (value.hostId === auth.hostId) await tx.delete(key);
    }
    return auth;
  }
  async schedule() {
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
  async alarm() {
    let remaining = false;
    for (const prefix of ['device:', 'limit:', 'auth:']) {
      for (const key of (await this.ctx.storage.list<any>({ prefix })).keys()) {
        await this.ctx.storage.transaction(async (tx) => {
          const value = await tx.get<any>(key);
          if (!value) return;
          if ((value.expires ?? value.until) <= Date.now()) {
            if (value.result) {
              await tx.delete('auth:' + (await digest(value.result.token)));
              if (value.role === 'agent') {
                const host = await tx.get<Host>('host:' + value.hostId);
                if (host)
                  await tx.put('host:' + host.id, { ...host, disabled: true });
                for (const [authKey, auth] of await tx.list<Auth>({
                  prefix: 'auth:',
                }))
                  if (auth.hostId === value.hostId) await tx.delete(authKey);
              }
            }
            await tx.delete(key);
          } else if (prefix !== 'auth:' || value.role === 'owner')
            remaining = true;
        });
      }
    }
    if (remaining) await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
}

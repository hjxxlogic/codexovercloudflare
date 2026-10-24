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

type Host = { id: string; name: string; disabled: boolean };
export class RegistryDO extends DurableObject<Env> {
  async fetch(req: Request) {
    try {
      const d = await body(req),
        op = new URL(req.url).pathname.slice(1),
        s = this.ctx.storage;
      if (op === 'login' || op === 'loginCodeRedeem') {
        if (!this.env.OWNER_SECRET || this.env.OWNER_SECRET.length < 32)
          throw new AppError(
            'NOT_CONFIGURED',
            'Owner secret must have at least 32 characters',
            503,
          );
        const key = 'limit:' + String(d.ip).slice(0, 100);
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
      if (op === 'loginCodeCreate') {
        const code = crypto.randomUUID().replaceAll('-', '').toUpperCase(),
          expires = Date.now() + 5 * 60000;
        await s.put('loginCode:' + (await digest(code)), { expires });
        await this.schedule();
        return json({ code, expires });
      }
      if (op === 'loginCodeRedeem') {
        const code = z
            .string()
            .min(1)
            .max(100)
            .parse(d.code)
            .trim()
            .toUpperCase(),
          key = 'loginCode:' + (await digest(code)),
          value = token(),
          hash = await digest(value),
          expires = Date.now() + 8 * 3600000;
        await s.transaction(async (tx) => {
          const grant = await tx.get<{ expires: number }>(key);
          if (!grant || grant.expires <= Date.now())
            throw new AppError(
              'UNAUTHORIZED',
              'Invalid or expired login code',
              401,
            );
          await tx.delete(key);
          await tx.put('auth:' + hash, {
            hash,
            role: 'client',
            expires,
          } satisfies Auth);
        });
        return json({ token: value, expires });
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
        if (!a || a.expires <= Date.now())
          throw new AppError(
            'UNAUTHORIZED',
            'Expired or invalid credentials',
            401,
          );
        if (a.hostId) {
          const h = await s.get<Host>('host:' + a.hostId);
          if (!h || h.disabled)
            throw new AppError('UNAUTHORIZED', 'Device disabled', 401);
        }
        return json(a);
      }
      if (op === 'logout') {
        await s.delete('auth:' + d.hash);
        return json({ ok: true });
      }
      if (op === 'enroll') {
        const name = z.string().min(1).max(100).parse(d.name),
          code = token(),
          id = crypto.randomUUID();
        if ((await s.list({ prefix: 'host:' })).size >= 5)
          throw new AppError('CAPACITY', 'At most five registered hosts', 409);
        await s.put('enroll:' + (await digest(code)), {
          id,
          name,
          expires: Date.now() + 5 * 60000,
        });
        await this.schedule();
        return json({ code, hostId: id, expiresIn: 300 });
      }
      if (op === 'redeem') {
        const key =
          'enroll:' + (await digest(z.string().max(500).parse(d.code)));
        // Transaction makes enrollment one-use even when two requests interleave.
        const e: any = await s.transaction(async (tx) => {
          const value: any = await tx.get(key);
          if (!value || value.expires < Date.now())
            throw new AppError('UNAUTHORIZED', 'Invalid enrollment code', 401);
          if ((await tx.list({ prefix: 'host:' })).size >= 5)
            throw new AppError('CAPACITY', 'Host capacity reached', 409);
          await tx.delete(key);
          await tx.put('host:' + value.id, {
            id: value.id,
            name: value.name,
            disabled: false,
          });
          return value;
        });
        const value = token(),
          hash = await digest(value);
        await s.put('auth:' + hash, {
          hash,
          role: 'agent',
          hostId: e.id,
          expires: Date.now() + 365 * 86400000,
        } satisfies Auth);
        return json({ token: value, hostId: e.id, name: e.name });
      }
      if (op === 'hosts')
        return json(
          Array.from((await s.list<Host>({ prefix: 'host:' })).values()),
        );
      if (op === 'host') {
        const h = await s.get<Host>('host:' + idSchema.parse(d.id));
        if (!h || h.disabled)
          throw new AppError('HOST_NOT_FOUND', 'Unknown or disabled host', 404);
        return json(h);
      }
      if (op === 'revoke') {
        const key = 'host:' + idSchema.parse(d.id),
          h = await s.get<Host>(key);
        if (!h) throw new AppError('HOST_NOT_FOUND', 'Unknown host', 404);
        await s.put(key, { ...h, disabled: true });
        return json({ ok: true });
      }
      throw new AppError('NOT_FOUND', 'Unknown operation', 404);
    } catch (e) {
      return failure(e);
    }
  }
  async schedule() {
    if (!(await this.ctx.storage.getAlarm()))
      await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
  async alarm() {
    let remaining = false;
    for (const prefix of ['auth:', 'enroll:', 'loginCode:', 'limit:']) {
      for (const [k, v] of await this.ctx.storage.list<any>({ prefix }))
        if ((v.expires ?? v.until) < Date.now())
          await this.ctx.storage.delete(k);
        else remaining = true;
    }
    if (remaining) await this.ctx.storage.setAlarm(Date.now() + 60000);
  }
}

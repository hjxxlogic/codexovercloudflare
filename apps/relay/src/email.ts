import { effectiveAdminEmail } from './project-auth.ts';
import type { StateTransaction } from './state.ts';
import {
  AppError,
  idSchema,
  accessEmailsSchema,
} from '../../../packages/protocol/src/index.ts';
import { digest, token, type Auth, type Env } from './common.ts';
import {
  adminEmailMatches,
  adminEmailVersion,
  type AccessUser,
  accessEnabled,
} from './access.ts';

export type EmailGrant = {
  id: string;
  accountId: string;
  email: string;
  hostId: string;
  created: number;
  lastSeen?: number;
  active: boolean;
  generation: string;
  approvedBy?: string;
  association?: boolean;
};
export function effectiveAccessEmails(host: any): string[] {
  return host.accessEmailsOverride ?? host.agentAccessEmails ?? [];
}
function admittedEmails(host: any): string[] {
  return [...effectiveAccessEmails(host), effectiveAdminEmail(host)].filter(
    Boolean,
  );
}
function associated(env: Env, host: any, user: AccessUser) {
  return (
    accessEnabled(env) &&
    user.issuer === env.ACCESS_TEAM_DOMAIN &&
    admittedEmails(host).includes(user.email)
  );
}
async function revokeGrant(tx: StateTransaction, grant: EmailGrant) {
  await tx.put(grant.id, { ...grant, active: false, revoked: Date.now() });
  const revoked: Auth[] = [];
  for (const [key, auth] of await tx.list<Auth>({ prefix: 'auth:' })) {
    if (
      auth.accountId === grant.accountId &&
      auth.hostId === grant.hostId &&
      auth.grantId
    ) {
      revoked.push(auth);
      await tx.delete(key);
    }
  }
  return revoked;
}
export async function setAccessEmails(
  tx: StateTransaction,
  env: Env,
  hostId: string,
  emails: unknown,
  agent: boolean,
) {
  const host = await validHost(tx, hostId);
  if (!agent && emails === null) delete host.accessEmailsOverride;
  else
    host[agent ? 'agentAccessEmails' : 'accessEmailsOverride'] =
      accessEmailsSchema.parse(emails);
  await tx.put('host:' + host.id, host);
  const revoked: Auth[] = [];
  for (const grant of (
    await tx.list<EmailGrant>({ prefix: 'emailGrant:' })
  ).values()) {
    if (
      grant.hostId === host.id &&
      grant.active &&
      grant.association &&
      (!admittedEmails(host).includes(grant.email) ||
        grant.accountId !==
          (await digest(JSON.stringify([env.ACCESS_TEAM_DOMAIN, grant.email]))))
    ) {
      revoked.push(...(await revokeGrant(tx, grant)));
    }
  }
  return { hostId: host.id, revoked };
}
export const grantKey = (accountId: string, hostId: string) =>
  `emailGrant:${accountId}:${hostId}`;
export async function account(tx: StateTransaction, user: AccessUser) {
  if (!user || !/^[a-f0-9]{64}$/.test(user.accountId))
    throw new AppError('ACCESS_USER_REQUIRED', 'Verified email required', 403);
  const key = 'emailAccount:' + user.accountId;
  if (!(await tx.get(key))) await tx.put(key, { ...user, created: Date.now() });
  return user;
}
export async function validHost(tx: StateTransaction, hostId: string) {
  const host = await tx.get<any>('host:' + idSchema.parse(hostId));
  if (!host || host.version !== 2 || host.disabled)
    throw new AppError('HOST_NOT_FOUND', 'Host unavailable', 404);
  return host;
}
export async function createEmailGrant(
  tx: StateTransaction,
  user: AccessUser,
  hostId: string,
  approvedBy?: string,
  association = false,
) {
  await account(tx, user);
  await validHost(tx, hostId);
  const key = grantKey(user.accountId, hostId);
  let grant = await tx.get<EmailGrant>(key);
  if (!grant?.active) {
    grant = {
      id: key,
      accountId: user.accountId,
      email: user.email,
      hostId,
      created: Date.now(),
      active: true,
      generation: token(),
      approvedBy,
      ...(association ? { association: true } : {}),
    };
    await tx.put(key, grant);
  } else if (grant.association && !association) {
    delete grant.association;
    await tx.put(key, grant);
  }
  return grant;
}
export async function validateEmailAuth(
  tx: StateTransaction,
  env: Env,
  auth: Auth,
) {
  if (auth.grantId) {
    const grant = await tx.get<EmailGrant>(
      grantKey(auth.accountId!, auth.hostId!),
    );
    if (!grant?.active || grant.generation !== auth.grantId)
      throw new AppError('UNAUTHORIZED', 'Email authorization revoked', 401);
    if (grant.association) {
      const host = await validHost(tx, grant.hostId);
      if (
        !admittedEmails(host).includes(grant.email) ||
        grant.accountId !==
          (await digest(JSON.stringify([env.ACCESS_TEAM_DOMAIN, grant.email])))
      )
        throw new AppError('UNAUTHORIZED', 'Email association removed', 401);
    }
  }
  if (
    auth.ownerSource === 'email' &&
    auth.adminEmailVersion !== (await adminEmailVersion(env))
  )
    throw new AppError(
      'UNAUTHORIZED',
      'Administrator email configuration changed',
      401,
    );
}
export async function emailOperation(
  tx: StateTransaction,
  env: Env,
  op: string,
  d: any,
) {
  const user: AccessUser = d.identity;
  if (op === 'emailGrantRevoke') {
    if (
      typeof d.id !== 'string' ||
      !/^emailGrant:[a-f0-9]{64}:[\w-]+$/.test(d.id)
    )
      throw new AppError('INVALID_REQUEST', 'Invalid grant', 400);
    const grant = await tx.get<EmailGrant>(d.id);
    if (!grant?.active)
      throw new AppError('NOT_FOUND', 'Unknown email grant', 404);
    if (grant.association) {
      const host = await validHost(tx, grant.hostId);
      host.accessEmailsOverride = effectiveAccessEmails(host).filter(
        (email) => email !== grant.email,
      );
      await tx.put('host:' + host.id, host);
    }
    const revoked = await revokeGrant(tx, grant);
    return { hostId: grant.hostId, revoked };
  }
  await account(tx, user);
  if (op === 'emailRestore' || op === 'emailMigrate') {
    const key = 'limit:email:' + user.accountId;
    let limit = await tx.get<{ count: number; until: number }>(key);
    if (!limit || limit.until <= Date.now())
      limit = { count: 0, until: Date.now() + 60000 };
    if (++limit.count > 60)
      throw new AppError(
        'RATE_LIMITED',
        'Too many email credential restorations; retry in one minute',
        429,
      );
    await tx.put(key, limit);
  }
  if (op === 'emailHosts') {
    const hosts = new Map<string, any>();
    for (const host of (await tx.list<any>({ prefix: 'host:' })).values())
      if (host.version === 2 && !host.disabled && associated(env, host, user))
        hosts.set(host.id, host);
    for (const grant of (
      await tx.list<EmailGrant>({ prefix: `emailGrant:${user.accountId}:` })
    ).values()) {
      const host = await tx.get<any>('host:' + grant.hostId);
      if (
        grant.active &&
        host?.version === 2 &&
        !host.disabled &&
        (!grant.association || associated(env, host, user))
      )
        hosts.set(host.id, host);
    }
    return [...hosts.values()];
  }
  if (op === 'emailRestore' || op === 'emailMigrate') {
    const host = await validHost(tx, d.hostId);
    let grant = await tx.get<EmailGrant>(grantKey(user.accountId, host.id));
    if (op === 'emailRestore' && associated(env, host, user))
      grant = await createEmailGrant(tx, user, host.id, 'association', true);
    if (op === 'emailMigrate') {
      const hash = await digest(d.token || '');
      const old = await tx.get<Auth>('auth:' + hash);
      if (
        !old ||
        old.role !== 'web' ||
        old.hostId !== host.id ||
        old.expires <= Date.now() ||
        old.accountId ||
        old.version !== 2
      )
        throw new AppError(
          'FORBIDDEN',
          'Valid unclaimed legacy web credential required',
          403,
        );
      grant = await createEmailGrant(tx, user, host.id, 'legacy:' + hash);
      await tx.delete('auth:' + hash);
    }
    if (!grant?.active || (grant.association && !associated(env, host, user)))
      throw new AppError(
        'FORBIDDEN',
        'This email is not authorized for the host',
        403,
      );
    const existing = d.token
      ? await tx.get<Auth>('auth:' + (await digest(d.token)))
      : undefined;
    if (
      existing?.role === 'web' &&
      existing.accountId === user.accountId &&
      existing.hostId === host.id &&
      existing.grantId === grant.generation &&
      existing.expires > Date.now()
    )
      return { token: d.token, hostId: host.id };
    const value = token();
    const auth: Auth = {
      hash: await digest(value),
      role: 'web',
      version: 2,
      name: user.email,
      email: user.email,
      accountId: user.accountId,
      grantId: grant.generation,
      hostId: host.id,
      created: Date.now(),
      expires: Date.now() + 30 * 86400000,
    };
    await tx.put('auth:' + auth.hash, auth);
    return {
      token: value,
      hostId: host.id,
      hash: auth.hash,
      expires: auth.expires,
    };
  }
  if (op === 'emailAdminLogin') {
    if (!adminEmailMatches(env, user))
      throw new AppError(
        'FORBIDDEN',
        'Administrator key required for this email',
        403,
      );
    const existing = d.token
      ? await tx.get<Auth>('auth:' + (await digest(d.token)))
      : undefined;
    const version = await adminEmailVersion(env);
    const ownerVersion = await digest(env.OWNER_SECRET);
    if (
      existing?.role === 'owner' &&
      existing.accountId === user.accountId &&
      existing.expires > Date.now() &&
      existing.ownerVersion === ownerVersion &&
      (existing.ownerSource !== 'email' ||
        existing.adminEmailVersion === version)
    )
      return { token: d.token, expires: existing.expires };
    const value = token(),
      hash = await digest(value),
      expires = Date.now() + 8 * 3600000;
    await tx.put('auth:' + hash, {
      hash,
      role: 'owner',
      version: 2,
      name: user.email,
      email: user.email,
      accountId: user.accountId,
      ownerSource: 'email',
      ownerVersion,
      adminEmailVersion: version,
      created: Date.now(),
      expires,
    } satisfies Auth);
    return { token: value, hash, expires };
  }
  throw new AppError('NOT_FOUND', 'Unknown email operation', 404);
}

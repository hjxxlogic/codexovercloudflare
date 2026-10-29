import { z } from 'zod';
import { AppError } from '../../../packages/protocol/src/index.ts';
import { digest, type Auth, type Env } from './common.ts';

export type AccessUser = { accountId: string; email: string; issuer: string };
type Identity = { user?: AccessUser; expires: number };
const identities = new WeakMap<Request, Identity>();
type Key = JsonWebKey & { kid?: string };
class AccessKeyError extends Error {
  constructor(readonly stage: string) {
    super(stage);
  }
}
const keySets = new Map<
  string,
  { keys: Key[]; expires: number; refreshed: number; pending?: Promise<Key[]> }
>();
export function accessEnabled(env: Env) {
  if (env.ACCESS_ENABLED && !['true', 'false'].includes(env.ACCESS_ENABLED))
    throw new AppError('ACCESS_CONFIG', 'Invalid ACCESS_ENABLED', 503);
  return env.ACCESS_ENABLED === 'true';
}
export function normalizeEmail(value: unknown) {
  const email = z.email().max(254).parse(value);
  const at = email.lastIndexOf('@');
  return email.slice(0, at) + '@' + email.slice(at + 1).toLowerCase();
}
export function accessUser(req: Request) {
  return identities.get(req)?.user;
}
export function requireAccessUser(req: Request) {
  const user = accessUser(req);
  if (!user)
    throw new AppError(
      'ACCESS_USER_REQUIRED',
      'Verified email login required',
      403,
    );
  return user;
}
export function adminEmailMatches(env: Env, user: AccessUser) {
  return (
    accessEnabled(env) &&
    !!env.ADMIN_EMAIL &&
    user.issuer === env.ACCESS_TEAM_DOMAIN &&
    user.email === normalizeEmail(env.ADMIN_EMAIL)
  );
}
export async function adminEmailVersion(env: Env) {
  return digest(
    JSON.stringify([
      env.ACCESS_ENABLED,
      env.ACCESS_TEAM_DOMAIN,
      env.ACCESS_AUD,
      env.ADMIN_EMAIL ? normalizeEmail(env.ADMIN_EMAIL) : '',
    ]),
  );
}
export function bindBrowser(req: Request, env: Env, auth: Auth) {
  if (!accessEnabled(env) || !['web', 'owner'].includes(auth.role)) return;
  const user = requireAccessUser(req);
  if (auth.accountId !== user.accountId)
    throw new AppError(
      'ACCESS_ACCOUNT_MISMATCH',
      'Sign in again with this email or explicitly migrate the legacy grant',
      403,
    );
}
function decode(part: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('JWT encoding');
  return Uint8Array.from(
    atob(part.replace(/-/g, '+').replace(/_/g, '/')),
    (c) => c.charCodeAt(0),
  );
}
async function keysFor(issuer: string, kid: string): Promise<Key[]> {
  let entry = keySets.get(issuer);
  if (!entry) {
    entry = { keys: [], expires: 0, refreshed: 0 };
    keySets.set(issuer, entry);
  }
  if (entry.pending) return entry.pending;
  if (
    entry.expires > Date.now() &&
    (entry.keys.some((k) => k.kid === kid) ||
      Date.now() - entry.refreshed < 30000)
  )
    return entry.keys;
  const current = entry;
  current.pending = (async () => {
    let response: Response;
    try {
      response = await fetch(issuer + '/cdn-cgi/access/certs', {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
    } catch (error) {
      throw new AccessKeyError(
        error instanceof Error &&
          ['TimeoutError', 'AbortError'].includes(error.name)
          ? 'keys_timeout'
          : 'keys_network',
      );
    }
    if (!response.ok) throw new AccessKeyError(`keys_http_${response.status}`);
    let body;
    try {
      const text = await response.text();
      if (text.length > 65536) throw new Error('JWKS size');
      body = JSON.parse(text);
    } catch {
      throw new AccessKeyError('keys_format');
    }
    if (!body || !Array.isArray(body.keys) || body.keys.length > 32)
      throw new AccessKeyError('keys_format');
    current.keys = body.keys;
    current.refreshed = Date.now();
    current.expires = Date.now() + 300000;
    return current.keys;
  })();
  try {
    return await current.pending;
  } finally {
    current.pending = undefined;
  }
}
function applicationToken(req: Request) {
  const assertion = req.headers.get('Cf-Access-Jwt-Assertion');
  if (assertion !== null) return assertion;
  const tokens = (req.headers.get('Cookie') || '')
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('CF_Authorization='));
  if (tokens.length !== 1)
    throw new Error('Missing or ambiguous application cookie');
  return tokens[0].slice('CF_Authorization='.length);
}
export async function verifyAccess(req: Request, env: Env) {
  if (!accessEnabled(env)) return;
  if (
    !env.ACCESS_TEAM_DOMAIN ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(
      env.ACCESS_TEAM_DOMAIN,
    ) ||
    !env.ACCESS_AUD
  )
    throw new AppError(
      'ACCESS_CONFIG',
      'Configure ACCESS_TEAM_DOMAIN and ACCESS_AUD',
      503,
    );
  if (env.ADMIN_EMAIL) {
    try {
      normalizeEmail(env.ADMIN_EMAIL);
    } catch {
      throw new AppError('ACCESS_CONFIG', 'Invalid ADMIN_EMAIL', 503);
    }
  }
  let stage = 'token';
  try {
    const jwt = applicationToken(req);
    if (!jwt || jwt.length > 16384) throw new Error('Missing JWT');
    const parts = jwt.split('.');
    if (parts.length !== 3) throw new Error('JWT shape');
    const header = JSON.parse(new TextDecoder().decode(decode(parts[0])));
    if (
      header.alg !== 'RS256' ||
      typeof header.kid !== 'string' ||
      header.crit !== undefined
    )
      throw new Error('JWT algorithm');
    stage = 'keys';
    const keys = await keysFor(env.ACCESS_TEAM_DOMAIN, header.kid);
    stage = 'key_id';
    const jwk = keys.find(
      (k) =>
        k.kid === header.kid &&
        k.kty === 'RSA' &&
        (!k.alg || k.alg === 'RS256') &&
        (!k.use || k.use === 'sig'),
    );
    if (!jwk) throw new Error('Unknown key');
    stage = 'signature';
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    if (
      !(await crypto.subtle.verify(
        'RSASSA-PKCS1-v1_5',
        key,
        decode(parts[2]),
        new TextEncoder().encode(parts[0] + '.' + parts[1]),
      ))
    )
      throw new Error('Signature');
    stage = 'claims';
    const payload = JSON.parse(new TextDecoder().decode(decode(parts[1])));
    const now = Date.now() / 1000;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (
      payload.iss !== env.ACCESS_TEAM_DOMAIN ||
      !audiences.includes(env.ACCESS_AUD) ||
      payload.type !== 'app' ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= now ||
      (payload.nbf !== undefined &&
        (!Number.isSafeInteger(payload.nbf) || payload.nbf > now)) ||
      (payload.iat !== undefined &&
        (!Number.isSafeInteger(payload.iat) || payload.iat > now + 30))
    )
      throw new Error('Claims');
    stage = 'identity';
    let user: AccessUser | undefined;
    if (
      payload.email !== undefined &&
      payload.email !== null &&
      payload.email !== ''
    ) {
      const email = normalizeEmail(payload.email);
      user = {
        email,
        issuer: payload.iss,
        accountId: await digest(JSON.stringify([payload.iss, email])),
      };
    }
    identities.set(req, { user, expires: payload.exp * 1000 });
  } catch (error) {
    if (error instanceof AccessKeyError) stage = error.stage;
    throw new AppError(
      'ACCESS_REQUIRED',
      `Cloudflare Access authentication failed (${stage}); sign in again or check the Access application configuration`,
      401,
    );
  }
}

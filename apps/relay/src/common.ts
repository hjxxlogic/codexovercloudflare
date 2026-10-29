import {
  AppError,
  errorData,
  MAX_FRAME,
} from '../../../packages/protocol/src/index.ts';
import { D1State, d1Enabled } from './state.ts';
import type { HostLocation } from './host-lifecycle.ts';
export interface Env {
  OWNER_SECRET: string;
  ACCESS_ENABLED?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAIL?: string;
  ACCESS_PUBLIC_HEALTH?: string;
  REGISTRY: DurableObjectNamespace;
  HOSTS: DurableObjectNamespace;
  STATE_BACKEND?: string;
  STATE_DB?: D1Database;
  ASSETS: Fetcher;
}
export type Auth = {
  hash: string;
  role: 'owner' | 'cli' | 'web' | 'agent';
  hostId?: string;
  expires: number;
  version: 2;
  name: string;
  created: number;
  lastSeen?: number;
  apiKeyId?: string;
  ownerVersion?: string;
  accountId?: string;
  email?: string;
  grantId?: string;
  ownerSource?: 'email' | 'secret';
  adminEmailVersion?: string;
};
export const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-CoC-Demand': '1', ...headers },
  });
export async function body(req: Request): Promise<any> {
  if (Number(req.headers.get('content-length') || 0) > MAX_FRAME)
    throw new AppError('MESSAGE_TOO_LARGE', 'Request too large', 413);
  const reader = req.body?.getReader();
  if (!reader) return {};
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_FRAME) {
      await reader.cancel();
      throw new AppError('MESSAGE_TOO_LARGE', 'Request too large', 413);
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    bytes.set(p, offset);
    offset += p.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export async function digest(s: string) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(s),
  );
  return Array.from(new Uint8Array(bytes), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
export function token() {
  return crypto.randomUUID() + crypto.randomUUID();
}
export function failure(e: unknown) {
  return json({ error: errorData(e) }, e instanceof AppError ? e.status : 400);
}
export function registry(env: Env) {
  return env.REGISTRY.get(env.REGISTRY.idFromName('owner'));
}
export async function registryCall(
  env: Env,
  op: string,
  data: unknown = {},
  source: 'worker' | 'host' = 'worker',
): Promise<any> {
  const started = Date.now();
  const request = new Request('https://internal/' + op, {
    method: 'POST',
    headers: {
      'x-coc-email-auth':
        env.ACCESS_ENABLED === 'true' ? 'required' : 'optional',
    },
    body: JSON.stringify(data),
  });
  let r: Response;
  const reads = [
    'auth',
    'authHash',
    'authHost',
    'host',
    'hosts',
    'apiKeys',
    'devices',
    'emailHosts',
    'migrationHosts',
  ];
  if (
    d1Enabled(env) &&
    reads.includes(op) &&
    (await new D1State(env.STATE_DB, 'registry').get('@migrated'))
  ) {
    const { RegistryCore } = await import('./registry.ts');
    const storage = new D1State(env.STATE_DB, 'registry');
    const core = new RegistryCore(
      { getWebSockets: () => [] } as unknown as DurableObjectState,
      env,
      storage,
    );
    r = await core.fetch(request);
  } else r = await registry(env).fetch(request);
  console.log(
    JSON.stringify({
      event: 'registry_call',
      source,
      operation: op,
      durationMs: Date.now() - started,
      status: r.status,
    }),
  );
  const b: any = await r.json();
  if (!r.ok) throw new AppError(b.error.code, b.error.message, r.status);
  return b;
}
export function hostStub(env: Env, id: string) {
  return env.HOSTS.get(env.HOSTS.idFromName(id));
}

export async function hostStatus(env: Env, id: string): Promise<any> {
  if (d1Enabled(env)) {
    const storage = new D1State(env.STATE_DB, 'host:' + id);
    const records = await storage.getMany([
      '@migrated',
      '@location',
      'presence',
    ]);
    const location = records.get('@location') as HostLocation | undefined;
    const presence = records.get('presence');
    if (records.has('@migrated') && location?.owner !== 'do' && presence) {
      return {
        online: presence?.online === true,
        confirmed: false,
        reachability: presence?.online ? 'unconfirmed' : 'offline',
        build: presence?.build,
        protocol: presence?.protocol,
      };
    }
  }
  // A legacy host is touched once to migrate its state and inspect attachments.
  return (
    await hostStub(env, id).fetch('https://internal/status', {
      headers: { 'x-host': id },
    })
  ).json();
}

export async function hostHasConnections(env: Env, id: string) {
  if (!d1Enabled(env)) return true;
  const storage = new D1State(env.STATE_DB, 'host:' + id);
  const records = await storage.getMany(['@migrated', '@location', 'presence']);
  if (!records.has('@migrated') || records.get('@location')?.owner === 'do')
    return true;
  const presence = records.get('presence');
  return !presence || presence.connected > 0;
}

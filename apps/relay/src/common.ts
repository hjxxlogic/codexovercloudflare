import {
  AppError,
  errorData,
  MAX_FRAME,
} from '../../../packages/protocol/src/admission.ts';
export interface Env {
  OWNER_SECRET: string;
  SETTINGS?: KVNamespace;
  ACCESS_ENABLED?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ADMIN_EMAIL?: string;
  ACCESS_PUBLIC_HEALTH?: string;
  REGISTRY: DurableObjectNamespace;
  HOSTS: DurableObjectNamespace;
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
  manager?: {
    kind: 'email' | 'owner';
    email?: string;
    accountId?: string;
    ownerVersion?: string;
    ownerSource?: 'email' | 'secret';
    adminEmailVersion?: string;
  };
};
export const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-CoC-Demand': '1',
      'X-CoC-Delivery': '2',
      ...headers,
    },
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
  const error = errorData(e);
  return json(
    { error },
    e instanceof AppError
      ? e.status
      : error.code === 'INVALID_REQUEST'
        ? 400
        : 500,
  );
}
export function authorizationFailed(error: unknown) {
  return error instanceof AppError && [401, 403].includes(error.status);
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
  const r = await registry(env).fetch(request);
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
  const response = await hostStub(env, id).fetch('https://internal/status', {
    headers: { 'x-host': id },
  });
  const result: any = await response.json();
  if (!response.ok)
    throw new AppError(
      result.error?.code || 'HOST_STATUS_UNAVAILABLE',
      result.error?.message || 'Host status temporarily unavailable',
      response.status,
    );
  return {
    online: result.online,
    confirmed: result.confirmed ?? false,
    ...(result.reachability ? { reachability: result.reachability } : {}),
  };
}

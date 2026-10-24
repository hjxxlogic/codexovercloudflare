import {
  AppError,
  errorData,
  MAX_FRAME,
} from '../../../packages/protocol/src/index.ts';
export interface Env {
  OWNER_SECRET: string;
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
};
export const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
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
): Promise<any> {
  const r = await registry(env).fetch('https://internal/' + op, {
    method: 'POST',
    body: JSON.stringify(data),
  });
  const b: any = await r.json();
  if (!r.ok) throw new AppError(b.error.code, b.error.message, r.status);
  return b;
}
export function hostStub(env: Env, id: string) {
  return env.HOSTS.get(env.HOSTS.idFromName(id));
}

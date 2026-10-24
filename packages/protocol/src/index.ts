import { z } from 'zod';

export const MAX_FRAME = 256 * 1024;
export const MAX_QUEUE = 8 * 1024 * 1024;
export const CODEX_VERSION = '0.164.0';
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const projectSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(100),
  path: z.string().min(1),
});
export const agentConfigSchema = z.object({
  relayUrl: z.string().url().default('https://r.xlogic.cc'),
  hostId: idSchema,
  token: z.string().min(20),
  codexPath: z.string().default('codex'),
  codexArgs: z.array(z.string()).default([]),
  dataDir: z.string().min(1),
  projects: z.array(projectSchema).min(1).max(20),
  sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Session = {
  id: string;
  projectId: string;
  mode: 'web' | 'cli';
  state: 'ready' | 'closed' | 'failed';
  threadId?: string;
  turnId?: string;
  sandbox?: 'read-only' | 'workspace-write';
  running: boolean;
  createdAt: number;
};
export const webCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('sync'),
    after: z.number().int().nonnegative().default(0),
  }),
  z.object({
    action: z.literal('prompt'),
    requestId: idSchema,
    text: z.string().trim().min(1).max(64000),
  }),
  z.object({ action: z.literal('interrupt'), requestId: idSchema }),
  z.object({
    action: z.literal('approval'),
    requestId: idSchema,
    approvalId: z.string().max(200),
    allow: z.boolean(),
  }),
]);
export type WebCommand = z.infer<typeof webCommandSchema>;
export type Event = { seq: number; type: string; data: unknown; time: number };
export type Rpc = {
  id?: string | number;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
};
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function errorData(e: unknown) {
  return e instanceof AppError
    ? { code: e.code, message: e.message }
    : {
        code: 'INVALID_REQUEST',
        message:
          e instanceof z.ZodError ? 'Invalid request fields' : 'Request failed',
      };
}
export function relayUrl(value: string) {
  const u = new URL(value);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/')
    throw new AppError(
      'BAD_URL',
      'Use a relay origin without path or credentials',
    );
  if (
    u.protocol !== 'https:' &&
    !(
      u.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
    )
  )
    throw new AppError('BAD_URL', 'HTTPS is required outside loopback');
  return u.origin;
}
export function wsUrl(origin: string, path: string) {
  return relayUrl(origin).replace(/^http/, 'ws') + path;
}
export function parseFrame(raw: string): any {
  if (new TextEncoder().encode(raw).length > MAX_FRAME)
    throw new AppError('MESSAGE_TOO_LARGE', 'Message exceeds 256 KiB');
  return JSON.parse(raw);
}

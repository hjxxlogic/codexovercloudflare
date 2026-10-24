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
  autoUpdate: z
    .union([
      z.boolean(),
      z.object({
        enabled: z.boolean().optional(),
        intervalHours: z.number().int().min(1).max(168).optional(),
        platform: z.enum(['', 'ubuntu20.04', 'debian12']).optional(),
      }),
    ])
    .optional(),
  codexPath: z.string().default('codex'),
  codexArgs: z.array(z.string()).default([]),
  dataDir: z.string().min(1),
  projects: z.array(projectSchema).min(1).max(20),
  sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type Project = z.infer<typeof projectSchema>;
export const sessionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,100}~[a-zA-Z0-9_-]{1,100}$/),
  projectId: idSchema,
  mode: z.enum(['web', 'cli']),
  state: z.enum(['starting', 'ready', 'closing', 'closed', 'failed']),
  threadId: idSchema.optional(),
  turnId: z.string().max(200).optional(),
  sandbox: z.enum(['read-only', 'workspace-write']).optional(),
  running: z.boolean(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  title: z.string().max(320).optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export const webCommandSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('sync'),
    after: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
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
const sequenceSchema = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
export const historyCommandSchema = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('page'),
      requestId: idSchema,
      before: sequenceSchema.optional(),
      after: sequenceSchema.nonnegative().optional(),
    })
    .refine(
      (v) => v.before === undefined || v.after === undefined,
      'Choose one pagination direction',
    ),
  z.object({
    operation: z.literal('content'),
    requestId: idSchema,
    seq: sequenceSchema,
    offset: sequenceSchema.nonnegative().default(0),
    revision: sequenceSchema.nonnegative().optional(),
  }),
]);
export const workspaceFileCommandSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('list'),
    path: z.string().max(4096).default(''),
    after: z.string().max(255).default(''),
  }),
  z.object({
    operation: z.literal('read'),
    path: z.string().min(1).max(4096),
    offset: z
      .number()
      .int()
      .min(0)
      .max(20 * 1024 * 1024)
      .default(0),
    version: z.string().max(300).optional(),
  }),
  z.object({
    operation: z.literal('begin'),
    path: z.string().min(1).max(4096),
    uploadId: idSchema,
    size: z
      .number()
      .int()
      .min(0)
      .max(20 * 1024 * 1024),
    overwrite: z.boolean().default(false),
  }),
  z.object({
    operation: z.literal('chunk'),
    uploadId: idSchema,
    offset: z
      .number()
      .int()
      .min(0)
      .max(20 * 1024 * 1024),
    data: z.string().max(87384),
  }),
  z.object({
    operation: z.enum(['finish', 'cancel', 'status']),
    uploadId: idSchema,
  }),
]);
export type WebCommand = z.infer<typeof webCommandSchema>;
export const eventSchema = z.object({
  seq: sequenceSchema,
  type: z.string().min(1).max(200),
  data: z.unknown(),
  time: sequenceSchema.nonnegative(),
  contentSeq: sequenceSchema.optional(),
  revision: sequenceSchema.nonnegative().optional(),
});
export type Event = z.infer<typeof eventSchema>;
export const agentBuildSchema = z.object({
  version: z.string().min(1).max(50),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  target: z.string().min(1).max(100),
  protocol: z.literal(1),
  capabilities: z.array(z.string().min(1).max(100)).max(32),
  dirty: z.boolean(),
  verified: z.boolean().optional(),
});
export type AgentBuild = z.infer<typeof agentBuildSchema>;
const sessionIdSchema = sessionSchema.shape.id;
const control = <A extends string, D extends z.ZodType>(action: A, data: D) =>
  z.object({ action: z.literal(action), data });
export const controlCommandSchema = z.discriminatedUnion('action', [
  control('projects', z.object({})),
  control(
    'list',
    z.object({
      paged: z.boolean().default(false),
      cursor: z.string().max(201).default(''),
      projectId: idSchema.optional(),
      mode: z.enum(['web', 'cli']).optional(),
      state: sessionSchema.shape.state.optional(),
    }),
  ),
  control('get', z.object({ sessionId: sessionIdSchema })),
  control('stop', z.object({ sessionId: sessionIdSchema })),
  control(
    'attach',
    z.object({
      sessionId: sessionIdSchema,
      epoch: sequenceSchema.positive(),
      expires: sequenceSchema.nonnegative(),
    }),
  ),
  control(
    'create',
    z.object({
      key: z.string().min(1).max(202),
      projectId: idSchema,
      mode: z.enum(['web', 'cli']),
      threadId: idSchema.optional(),
    }),
  ),
  control(
    'request',
    z.object({
      sessionId: sessionIdSchema.optional(),
      requestId: z.string().min(1).max(202),
      mode: z.enum(['web', 'cli']),
    }),
  ),
  control(
    'threads',
    z.object({
      projectId: idSchema,
      cursor: z.string().max(4096).nullable().optional(),
    }),
  ),
  control(
    'history',
    z
      .object({
        sessionId: sessionIdSchema,
        operation: z.enum(['page', 'content']),
        before: sequenceSchema.optional(),
        after: sequenceSchema.nonnegative().optional(),
        seq: sequenceSchema.optional(),
        offset: sequenceSchema.nonnegative().optional(),
        revision: sequenceSchema.nonnegative().optional(),
      })
      .refine((v) =>
        v.operation === 'content'
          ? v.seq !== undefined
          : v.before === undefined || v.after === undefined,
      ),
  ),
  control(
    'files',
    z.intersection(
      workspaceFileCommandSchema,
      z.object({
        projectId: idSchema,
        owner: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    ),
  ),
]);
export type ControlCommand = z.infer<typeof controlCommandSchema>;
export const controlResultSchema = z
  .object({
    type: z.literal('result'),
    v: z.literal(1),
    requestId: idSchema,
    data: z.unknown().optional(),
    error: z
      .object({ code: z.string().max(100), message: z.string().max(4096) })
      .optional(),
  })
  .refine((v) => (v.error === undefined) !== (v.data === undefined));
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

import { z } from 'zod';

export const MAX_FRAME = 256 * 1024;
export const MAX_QUEUE = 8 * 1024 * 1024;
export const CODEX_VERSION = '0.164.0';
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const accessEmailSchema = z
  .string()
  .max(254)
  .regex(
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?![\s\S])/,
  )
  .transform((email) => {
    const at = email.lastIndexOf('@');
    return email.slice(0, at) + email.slice(at).toLowerCase();
  });
export const accessEmailsSchema = z
  .array(accessEmailSchema)
  .transform((emails) => [...new Set(emails)].sort());
export const modelIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}(?![\s\S])/);
export const wakeUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value === '') return true;
    if (
      !/^https?:\/\/(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(:[0-9]{1,5})?([/?][^\s\\#]*)?$/.test(
        value,
      )
    )
      return false;
    try {
      const url = new URL(value);
      return (
        url.port !== '0' &&
        (url.protocol === 'https:' ||
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      );
    } catch {
      return false;
    }
  }, 'Use an HTTPS wake URL without credentials or fragment (HTTP only on loopback)');
export const projectSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(100),
  path: z.string().min(1),
});
const projectPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (path) =>
      !path.includes('\0') && new TextEncoder().encode(path).length <= 4096,
  );
const projectDisplayNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(
    (name) =>
      !Array.from(name).some(
        (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
      ),
  );
const projectChange = {
  requestId: idSchema,
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
export const projectManagementSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('list') }),
  z.object({ operation: z.literal('browse'), path: projectPathSchema }),
  z.object({
    operation: z.literal('add'),
    ...projectChange,
    path: projectPathSchema,
    id: idSchema.optional(),
    name: projectDisplayNameSchema.optional(),
    mkdir: z.boolean().default(false),
  }),
  z.object({
    operation: z.literal('rename'),
    ...projectChange,
    id: idSchema,
    name: projectDisplayNameSchema,
  }),
  z.object({ operation: z.literal('remove'), ...projectChange, id: idSchema }),
]);
export const agentConfigSchema = z.object({
  relayUrl: z.string().url().default('https://r.xlogic.cc'),
  hostId: idSchema,
  token: z.string().min(20),
  wakeUrl: wakeUrlSchema.optional(),
  accessEmails: accessEmailsSchema.optional(),
  adminEmail: z.union([z.literal(''), accessEmailSchema]).optional(),
  autoUpdate: z
    .union([
      z.boolean(),
      z.object({
        enabled: z.boolean().optional(),
        intervalHours: z.number().int().min(1).max(168).optional(),
        platform: z
          .enum(['', 'ubuntu20.04', 'debian12', 'windows-x64'])
          .optional(),
      }),
    ])
    .optional(),
  externalSessions: z
    .object({
      allowQueue: z.boolean().default(false),
      allowApprovals: z.boolean().optional(),
      approvalEndpoint: z.string().max(4096).optional(),
      approvalTokenFile: z.string().max(4096).optional(),
    })
    .optional(),
  codexPath: z.string().default('codex'),
  codexArgs: z.array(z.string()).default([]),
  dataDir: z.string().min(1),
  projects: z.array(projectSchema),
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
  external: z.boolean().optional(),
  queueEnabled: z.boolean().optional(),
  approvalConfigured: z.boolean().optional(),
  approvalForwarding: z.boolean().optional(),
  autoApproval: z.boolean().optional(),
  externalStatus: z.enum(['active', 'idle', 'unknown']).optional(),
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
    model: modelIdSchema.optional(),
  }),
  z.object({
    action: z.literal('models'),
    requestId: idSchema,
    cursor: z.string().max(4096).optional(),
  }),
  z.object({ action: z.literal('interrupt'), requestId: idSchema }),
  z.object({
    action: z.literal('autoApproval'),
    requestId: idSchema,
    enabled: z.boolean(),
  }),
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
  control('probe', z.object({})),
  control(
    'delivery',
    z.object({
      sessionId: sessionIdSchema,
      mode: z.enum(['web', 'cli']),
      stream: idSchema,
      lane: z.enum(['normal', 'priority']),
      seq: sequenceSchema.positive().optional(),
    }),
  ),
  control('projects', z.object({})),
  control('projectManage', projectManagementSchema),
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
  control(
    'snapshot',
    z.object({
      sessionId: sessionIdSchema,
      mode: z.enum(['web', 'cli']),
      after: sequenceSchema.nonnegative().optional(),
    }),
  ),
  control('stop', z.object({ sessionId: sessionIdSchema })),
  control(
    'attach',
    z.object({
      sessionId: sessionIdSchema,
      epoch: sequenceSchema.positive(),
      expires: sequenceSchema.nonnegative(),
      deliveryResume: idSchema.optional(),
    }),
  ),
  control(
    'create',
    z.object({
      key: z.string().min(1).max(202),
      projectId: idSchema,
      mode: z.enum(['web', 'cli']),
      threadId: idSchema.optional(),
      external: z.boolean().optional(),
    }),
  ),
  control(
    'approvals',
    z.object({ sessionId: sessionIdSchema, mode: z.enum(['web', 'cli']) }),
  ),
  control(
    'answer',
    z.object({
      sessionId: sessionIdSchema,
      mode: z.enum(['web', 'cli']),
      requestId: idSchema,
      approvalId: z.string().min(1).max(200),
      allow: z.boolean(),
    }),
  ),
  control(
    'queue',
    z.object({
      sessionId: sessionIdSchema,
      mode: z.enum(['web', 'cli']),
      requestId: idSchema,
      text: z.string().trim().min(1).max(64000),
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
    heads: z
      .object({
        agent: sequenceSchema.nonnegative(),
        rpc: sequenceSchema.nonnegative(),
      })
      .optional(),
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
    : e instanceof z.ZodError || e instanceof SyntaxError
      ? { code: 'INVALID_REQUEST', message: 'Invalid request fields' }
      : { code: 'INTERNAL_ERROR', message: 'Service temporarily unavailable' };
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

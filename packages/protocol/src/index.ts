import { z } from 'zod';

export const MAX_FRAME = 256 * 1024;
export const MAX_QUEUE = 8 * 1024 * 1024;
export const CODEX_VERSION = '0.164.0';
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const operationIntentSchema = z.object({
  requestId: idSchema,
  instance: idSchema,
  owner: z.string().regex(/^[a-f0-9]{64}$/),
  ack: z.boolean().optional(),
});
export type OperationIntent = z.infer<typeof operationIntentSchema>;
// Chunk retransmission and cancellation use the upload ledger's own immutable
// identity. Beginning/publishing an upload requires the HTTP original ledger.
export function operationWrite(action: string, data: { operation?: string }) {
  return (
    ['create', 'stop', 'queue', 'answer'].includes(action) ||
    (action === 'projectManage' &&
      !['list', 'browse'].includes(data.operation || '')) ||
    (action === 'files' &&
      ['begin', 'finish'].includes(data.operation || '')) ||
    (action === 'terminal' && ['open', 'close'].includes(data.operation || ''))
  );
}
export const controlProofSchema = z.object({
  controlEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  connectionGeneration: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER),
  controlId: idSchema,
  owner: idSchema,
});
export type ControlProof = z.infer<typeof controlProofSchema>;
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
export const historyStorageSchema = z
  .object({
    retainedRecords: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
    cacheMaxBytes: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    cacheMaxSessionBytes: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    cacheTargetPercent: z.number().int().min(1).max(100).default(80),
    readPageMaxBytes: z.number().int().min(1).max(1048576).default(1048576),
    readConcurrency: z.number().int().min(1).max(4).default(2),
    writeWindowBytes: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    writeWindowRecords: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    maxBytes: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(268435456),
    maxSessionBytes: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(67108864),
    maxRecords: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(250000),
    maxSessionRecords: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(64000),
    maxSessions: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(1024),
    minFreeDiskBytes: z
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(536870912),
  })
  .strict()
  .refine(
    (value) =>
      value.maxSessionBytes <= value.maxBytes &&
      value.maxSessionRecords <= value.maxRecords,
    'Session history limits exceed global limits',
  )
  .transform((value) => {
    const cacheMaxBytes =
      value.cacheMaxBytes ?? Math.min(67108864, value.maxBytes);
    return {
      ...value,
      writeWindowBytes:
        value.writeWindowBytes ?? Math.min(1048576, value.maxSessionBytes),
      writeWindowRecords:
        value.writeWindowRecords ?? Math.min(256, value.maxSessionRecords),
      cacheMaxBytes,
      cacheMaxSessionBytes:
        value.cacheMaxSessionBytes ??
        Math.min(16777216, value.maxSessionBytes, cacheMaxBytes),
    };
  })
  .refine(
    (value) =>
      value.cacheMaxBytes <= value.maxBytes &&
      value.cacheMaxSessionBytes <= value.maxSessionBytes &&
      value.cacheMaxSessionBytes <= value.cacheMaxBytes,
    'Invalid history cache limits',
  )
  .refine(
    (value) =>
      value.writeWindowBytes <= value.maxSessionBytes &&
      value.writeWindowRecords <= value.maxSessionRecords,
    'History write window exceeds session limits',
  );
export const agentConfigSchema = z.object({
  relayUrl: z.string().url().default('https://r.xlogic.cc'),
  hostId: idSchema,
  token: z.string().min(20),
  historyStorage: historyStorageSchema.optional(),
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
  codexUseProxy: z.boolean().default(false),
  terminal: z
    .object({ enabled: z.boolean().default(false) })
    .strict()
    .optional(),
  dataDir: z.string().min(1),
  projects: z.array(projectSchema),
  sandbox: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type Project = z.infer<typeof projectSchema>;
export const commandTargetSchema = z.object({
  controlEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  instance: idSchema,
  owner: idSchema,
  requestId: z
    .string()
    .min(1)
    .max(512)
    .refine((value) => new TextEncoder().encode(value).length <= 512),
  stream: idSchema,
  turnId: z.string().min(1).max(200).optional(),
});
export type CommandTarget = z.infer<typeof commandTargetSchema>;
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
  activeTask: commandTargetSchema.optional(),
  historySyncPending: z.boolean().optional(),
  historyError: z
    .object({
      code: z.literal('BACKPRESSURE'),
      message: z.string().max(1000),
      incomplete: z.literal(true),
    })
    .optional(),
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
  z.object({
    action: z.literal('interrupt'),
    requestId: idSchema,
    target: commandTargetSchema,
  }),
  z.object({
    action: z.literal('autoApproval'),
    requestId: idSchema,
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal('approval'),
    requestId: idSchema,
    approvalId: z.string().min(1).max(200),
    runtimeId: idSchema,
    approvalVersion: idSchema,
    allow: z.boolean(),
  }),
]);
const sequenceSchema = z
  .number()
  .int()
  .min(-Number.MAX_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
export const historyReferenceSchema = z
  .object({
    type: z.literal('delivery-content'),
    retention: z.literal('history'),
    agentInstance: idSchema,
    sessionId: sessionSchema.shape.id,
    seq: sequenceSchema,
    revision: sequenceSchema.nonnegative(),
    length: sequenceSchema.nonnegative().max(64 * 1024 * 1024),
    contentId: z.string().regex(/^[a-f0-9]{64}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .refine(
    (v) => v.contentId === v.digest,
    'History content identity must match its digest',
  );
export type HistoryReference = z.infer<typeof historyReferenceSchema>;
const historySubscriptionFields = {
  stream: idSchema,
  instance: idSchema,
  agentInstance: idSchema.optional(),
  exchangeId: idSchema,
  receivedRevision: sequenceSchema.nonnegative(),
  acknowledgedRevision: sequenceSchema.nonnegative(),
  streamSerial: sequenceSchema.positive().optional(),
  creditGeneration: idSchema.optional(),
};
export const historyCommandSchema = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('subscribe'),
    requestId: idSchema,
    ...historySubscriptionFields,
  }),
  z.object({
    operation: z.enum(['ack', 'retire']),
    requestId: idSchema,
    releasedRevision: sequenceSchema.nonnegative().optional(),
    ...historySubscriptionFields,
    agentInstance: idSchema,
    streamSerial: sequenceSchema.positive(),
    creditGeneration: idSchema,
  }),
  z
    .object({
      operation: z.literal('page'),
      requestId: idSchema,
      historyVersion: z.literal(2).optional(),
      snapshotGeneration: sequenceSchema.nonnegative().optional(),
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
    reference: historyReferenceSchema.optional(),
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
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    operation: z.literal('chunk'),
    agentInstance: idSchema,
    uploadId: idSchema,
    offset: z
      .number()
      .int()
      .min(0)
      .max(20 * 1024 * 1024),
    data: z.string().max(87384),
  }),
  z.object({
    operation: z.literal('finish'),
    uploadId: idSchema,
    agentInstance: idSchema,
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.object({
    operation: z.enum(['cancel', 'status']),
    agentInstance: idSchema,
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
export const terminalCommandSchema = z
  .object({
    operation: z.enum(['info', 'open', 'read', 'input', 'resize', 'close']),
    projectId: idSchema,
    sessionId: sessionIdSchema.optional(),
    control: controlProofSchema.optional(),
    terminalId: idSchema.optional(),
    seq: sequenceSchema.positive().optional(),
    data: z
      .string()
      .min(4)
      .max(5464)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/)
      .optional(),
    offset: sequenceSchema.nonnegative().default(0),
    cols: z.number().int().min(2).max(500).default(80),
    rows: z.number().int().min(2).max(500).default(24),
  })
  .superRefine((d, ctx) => {
    if (
      d.operation !== 'info' &&
      (!d.sessionId || !d.control || (d.operation !== 'open' && !d.terminalId))
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Terminal requires current controller and runtime',
      });
    if (
      (['input', 'resize'].includes(d.operation) && !d.seq) ||
      (d.operation === 'input' && !d.data)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Terminal input requires sequence and data',
      });
  });
// Ephemeral Terminal byte stream; lifecycle operations retain their existing journal.
const terminalBase64 = (max: number) =>
  z
    .string()
    .min(4)
    .max(max)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/);
export const terminalStreamClientSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('bind'),
      projectId: idSchema,
      sessionId: sessionIdSchema,
      terminalId: idSchema,
      control: controlProofSchema,
      offset: sequenceSchema.nonnegative(),
    })
    .strict(),
  z
    .object({
      type: z.literal('input'),
      seq: sequenceSchema.positive(),
      data: terminalBase64(5464),
    })
    .strict(),
  z
    .object({
      type: z.literal('resize'),
      seq: sequenceSchema.positive(),
      cols: z.number().int().min(2).max(500),
      rows: z.number().int().min(2).max(500),
    })
    .strict(),
  z
    .object({ type: z.literal('ack'), offset: sequenceSchema.nonnegative() })
    .strict(),
  z.object({ type: z.literal('ping') }).strict(),
]);
export const terminalStreamServerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), next: sequenceSchema.positive() }),
  z.object({ type: z.literal('ack'), next: sequenceSchema.positive() }),
  z.object({
    type: z.literal('output'),
    offset: sequenceSchema.nonnegative(),
    data: terminalBase64(21848),
    gap: z.boolean(),
  }),
  z.object({ type: z.literal('exit'), exitCode: z.number().int() }),
  z.object({ type: z.literal('pong') }),
  z.object({
    type: z.literal('error'),
    error: z.object({
      code: z.string().max(100),
      message: z.string().max(2000),
    }),
  }),
]);
export const controlCommandSchema = z.discriminatedUnion('action', [
  control('probe', z.object({})),
  control(
    'terminal',
    z.intersection(
      terminalCommandSchema,
      z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/) }),
    ),
  ),
  control(
    'delivery',
    z
      .object({
        sessionId: sessionIdSchema,
        mode: z.enum(['web', 'cli']),
        stream: idSchema,
        lane: z.enum(['normal', 'priority']),
        exchangeId: idSchema.optional(),
        control: controlProofSchema.optional(),
        instance: idSchema.optional(),
        streamSerial: sequenceSchema.positive().optional(),
        creditGeneration: idSchema.optional(),
        resultReceived: sequenceSchema.nonnegative().optional(),
        resultBytes: sequenceSchema.nonnegative().optional(),
        contentSeq: sequenceSchema.positive().optional(),
        offset: sequenceSchema.nonnegative().optional(),
        seq: sequenceSchema.positive().optional(),
      })
      .refine(
        (d) =>
          d.instance && d.streamSerial && d.creditGeneration
            ? true
            : !!d.exchangeId &&
              d.streamSerial === undefined &&
              d.creditGeneration === undefined &&
              d.seq === undefined &&
              d.contentSeq === undefined &&
              (d.resultReceived ?? 0) === 0 &&
              (d.resultBytes ?? 0) === 0,
        'Original receiver credit allocation is required',
      ),
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
      runtimeId: idSchema,
      approvalVersion: idSchema,
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
        operation: z.enum(['page', 'content', 'subscribe', 'ack', 'retire']),
        stream: idSchema.optional(),
        instance: idSchema.optional(),
        agentInstance: idSchema.optional(),
        exchangeId: idSchema.optional(),
        receivedRevision: sequenceSchema.nonnegative().optional(),
        acknowledgedRevision: sequenceSchema.nonnegative().optional(),
        streamSerial: sequenceSchema.positive().optional(),
        creditGeneration: idSchema.optional(),
        owner: z.string().min(1).max(128).optional(),
        route: idSchema.optional(),
        before: sequenceSchema.optional(),
        after: sequenceSchema.nonnegative().optional(),
        seq: sequenceSchema.optional(),
        offset: sequenceSchema.nonnegative().optional(),
        revision: sequenceSchema.nonnegative().optional(),
        reference: historyReferenceSchema.optional(),
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

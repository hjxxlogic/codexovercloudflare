import { z } from 'zod';
import { idSchema, MAX_FRAME } from './index.ts';
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const deliveryLaneSchema = z.enum(['normal', 'priority']);
export type DeliveryLane = z.infer<typeof deliveryLaneSchema>;
export const deliveryAllocationSchema = z.object({
  instance: idSchema,
  streamSerial: counter.positive(),
  creditGeneration: idSchema,
});
export type DeliveryAllocation = z.infer<typeof deliveryAllocationSchema>;
export const deliveryWindowSchema = z.object({
  stream: idSchema,
  ...deliveryAllocationSchema.shape,
  closed: z.boolean().optional(),
  exhausted: z.boolean().optional(),
  received: counter,
  sent: counter.optional(),
  resultBytes: counter.optional(),
  receivedBytes: counter,
  credit: counter,
  byteCredit: counter,
});
export type DeliveryWindow = z.infer<typeof deliveryWindowSchema>;
export const deliveryFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delivery-open'),
    stream: idSchema,
    exchangeId: idSchema,
    instance: idSchema.optional(),
    allocations: z
      .object({
        normal: deliveryAllocationSchema.optional(),
        priority: deliveryAllocationSchema.optional(),
      })
      .default({}),
    received: z.object({ normal: counter, priority: counter }),
    receivedBytes: z.object({ normal: counter, priority: counter }),
  }),
  z.object({
    type: z.literal('delivery-receipt'),
    stream: idSchema,
    lane: deliveryLaneSchema,
    ...deliveryAllocationSchema.shape,
    received: counter,
    receivedBytes: counter,
  }),
  z.object({
    type: z.literal('delivery-command'),
    stream: idSchema,
    lane: deliveryLaneSchema,
    ...deliveryAllocationSchema.shape,
    seq: counter.positive(),
    end: counter.positive(),
    body: z
      .string()
      .min(1)
      .max(MAX_FRAME - 4096)
      .refine(
        (value) => new TextEncoder().encode(value).length <= MAX_FRAME - 4096,
      ),
  }),
  z.object({
    type: z.literal('delivery-content'),
    stream: idSchema,
    lane: deliveryLaneSchema,
    ...deliveryAllocationSchema.shape,
    resultSeq: counter.positive(),
    offset: counter,
  }),
  z.object({
    type: z.literal('delivery-query'),
    stream: idSchema,
    lane: deliveryLaneSchema,
    ...deliveryAllocationSchema.shape,
    seq: counter.positive(),
  }),
]);
export const deliveryResultSchema = z.object({
  seq: counter.positive(),
  resultStream: idSchema,
  resultSeq: counter.positive(),
  resultEnd: counter.positive(),
  resultBody: z
    .string()
    .min(1)
    .max(MAX_FRAME - 8192),
  resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export async function deliveryDigest(body: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
export function webDeliveryLane(command: {
  action: string;
}): DeliveryLane | undefined {
  if (['sync', 'models'].includes(command.action)) return;
  return ['approval', 'interrupt', 'autoApproval'].includes(command.action)
    ? 'priority'
    : 'normal';
}
// Only known, side-effect-free reads bypass command delivery. Unknown RPCs
// retain the Agent allowlist and enter the command lane if allowed at all.
export function rpcDeliveryLane(message: {
  method?: string;
}): DeliveryLane | undefined {
  if (
    message.method &&
    [
      'account/read',
      'account/rateLimits/read',
      'model/list',
      'thread/list',
      'thread/loaded/list',
      'thread/read',
      'thread/turns/list',
      'thread/queue/list',
      'config/read',
      'skills/list',
    ].includes(message.method)
  )
    return;
  return !message.method ||
    ['turn/interrupt', 'coc/cancel'].includes(message.method)
    ? 'priority'
    : 'normal';
}

export const transferDescriptorSchema = z.object({
  type: z.literal('delivery-content'),
  retention: z.literal('transfer'),
  contentId: z.string().regex(/^[a-f0-9]{64}$/),
  revision: z.literal(1),
  length: counter.positive().max(2 * 1024 * 1024),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const deliveryResetSchema = z.object({
  type: z.literal('delivery-reset'),
  lane: deliveryLaneSchema,
  exchangeId: idSchema,
  error: z.object({
    code: z.enum([
      'DELIVERY_STATE_MISMATCH',
      'STREAM_CLOSED',
      'RESULT_UNAVAILABLE',
      'STALE_CONTROLLER',
      'UNAUTHORIZED',
      'FORBIDDEN',
    ]),
    message: z.string().max(1024),
  }),
});

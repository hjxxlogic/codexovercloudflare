import { z } from 'zod';
import { idSchema, MAX_FRAME } from './index.ts';
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const deliveryLaneSchema = z.enum(['normal', 'priority']);
export type DeliveryLane = z.infer<typeof deliveryLaneSchema>;
export const deliveryWindowSchema = z.object({
  stream: idSchema,
  instance: idSchema,
  received: counter,
  sent: counter.optional(),
  receivedBytes: counter,
  credit: counter,
  byteCredit: counter,
});
export type DeliveryWindow = z.infer<typeof deliveryWindowSchema>;
export const deliveryFrameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('delivery-open'),
    stream: idSchema,
    received: z.object({ normal: counter, priority: counter }).optional(),
  }),
  z.object({
    type: z.literal('delivery-receipt'),
    stream: idSchema,
    lane: deliveryLaneSchema,
    received: counter,
  }),
  z.object({
    type: z.literal('delivery-command'),
    stream: idSchema,
    lane: deliveryLaneSchema,
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
    type: z.literal('delivery-query'),
    stream: idSchema,
    lane: deliveryLaneSchema,
    seq: counter.positive(),
  }),
]);
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
  return !message.method || message.method === 'turn/interrupt'
    ? 'priority'
    : 'normal';
}

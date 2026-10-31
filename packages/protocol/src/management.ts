import { z } from 'zod';
import { agentBuildSchema, idSchema } from './index.ts';

export const configurationTextSchema = z
  .string()
  .refine(
    (text) => new TextEncoder().encode(text).length <= 64 * 1024,
    'Configuration exceeds 64 KiB',
  );
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const configurationCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('read') }).strict(),
  z
    .object({
      action: z.literal('replace'),
      requestId: idSchema,
      revision,
      text: configurationTextSchema,
    })
    .strict(),
  z
    .object({
      action: z.literal('restart'),
      requestId: idSchema,
      revision,
      allowActive: z.boolean(),
    })
    .strict(),
]);
export const managementRequestSchema = z
  .object({
    target: idSchema,
    command: configurationCommandSchema,
  })
  .strict();
export const managementMetadataSchema = z.object({
  instance: z.string().uuid().optional(),
  path: z.string().min(1).max(4096),
  kind: z.enum(['agent', 'client']),
  pid: z.number().int().positive(),
  build: agentBuildSchema,
});

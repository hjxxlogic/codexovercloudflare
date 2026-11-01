import {
  configurationCommandSchema,
  managementRequestSchema,
  managementMetadataSchema,
} from '../packages/protocol/src/management.ts';
// Zod is the wire-shape source; native validation additionally uses shared fixtures.
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import {
  webCommandSchema,
  historyCommandSchema,
  workspaceFileCommandSchema,
  sessionSchema,
  eventSchema,
  agentBuildSchema,
  controlCommandSchema,
  controlProofSchema,
  commandTargetSchema,
  controlResultSchema,
  operationIntentSchema,
} from '../packages/protocol/src/index.ts';
import {
  deliveryFrameSchema,
  deliveryWindowSchema,
  deliveryAllocationSchema,
  deliveryResultSchema,
  transferDescriptorSchema,
  deliveryResetSchema,
} from '../packages/protocol/src/delivery.ts';
const schemas = {
  configurationCommand: configurationCommandSchema,
  managementRequest: managementRequestSchema,
  managementMetadata: managementMetadataSchema,
  deliveryFrame: deliveryFrameSchema,
  deliveryWindow: deliveryWindowSchema,
  deliveryAllocation: deliveryAllocationSchema,
  deliveryResult: deliveryResultSchema,
  transferDescriptor: transferDescriptorSchema,
  deliveryReset: deliveryResetSchema,
  webCommand: webCommandSchema,
  historyCommand: historyCommandSchema,
  workspaceFileCommand: workspaceFileCommandSchema,
  session: sessionSchema,
  event: eventSchema,
  agentBuild: agentBuildSchema,
  controlCommand: controlCommandSchema,
  controlProof: controlProofSchema,
  commandTarget: commandTargetSchema,
  controlResult: controlResultSchema,
  operationIntent: operationIntentSchema,
};
const output =
  JSON.stringify(
    Object.fromEntries(
      Object.entries(schemas).map(([name, schema]) => [
        name,
        z.toJSONSchema(schema),
      ]),
    ),
    null,
    2,
  ) + '\n';
const path = 'docs/protocol.generated.json';
if (process.argv.includes('--check')) {
  if (readFileSync(path, 'utf8') !== output)
    throw new Error(
      'Protocol documentation is stale; run npm run protocol:generate',
    );
} else writeFileSync(path, output);

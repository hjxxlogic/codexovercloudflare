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
  controlResultSchema,
} from '../packages/protocol/src/index.ts';
const schemas = {
  webCommand: webCommandSchema,
  historyCommand: historyCommandSchema,
  workspaceFileCommand: workspaceFileCommandSchema,
  session: sessionSchema,
  event: eventSchema,
  agentBuild: agentBuildSchema,
  controlCommand: controlCommandSchema,
  controlResult: controlResultSchema,
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

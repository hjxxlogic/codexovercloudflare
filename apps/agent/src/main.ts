import { readFileSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  agentConfigSchema,
  CODEX_VERSION,
  relayUrl,
} from '../../../packages/protocol/src/index.ts';
import { Agent } from './agent.ts';

try {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npm run agent -- /path/to/agent.json');
  const config = agentConfigSchema.parse(
    JSON.parse(readFileSync(path, 'utf8')),
  );
  config.relayUrl = relayUrl(config.relayUrl);
  chmodSync(path, 0o600);
  const version = execFileSync(
    config.codexPath,
    [...config.codexArgs, '--version'],
    { encoding: 'utf8' },
  ).trim();
  if (!version.endsWith(' ' + CODEX_VERSION))
    throw new Error(`Unsupported Codex version; expected ${CODEX_VERSION}`);
  const agent = new Agent(config);
  agent.start();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      if (stopping) return;
      stopping = true;
      void agent.close().finally(() => process.exit(0));
    });
} catch (e) {
  console.error(e instanceof Error ? e.message : 'Agent startup failed');
  process.exitCode = 1;
}

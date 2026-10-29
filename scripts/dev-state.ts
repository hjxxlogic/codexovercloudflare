import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { localStateConfig } from './state-config.ts';

mkdirSync('.local', { recursive: true });
const config = localStateConfig('.local/wrangler-d1.json');
const wrangler = 'node_modules/wrangler/bin/wrangler.js';
for (const args of [
  [
    'd1',
    'migrations',
    'apply',
    'STATE_DB',
    '--local',
    '--config',
    config,
    '--persist-to',
    '.wrangler/state',
  ],
  [
    'dev',
    '--config',
    config,
    '--persist-to',
    '.wrangler/state',
    '--ip',
    '127.0.0.1',
    '--port',
    '8787',
    '--var',
    'ACCESS_ENABLED:false',
  ],
]) {
  const result = spawnSync(process.execPath, [wrangler, ...args], {
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

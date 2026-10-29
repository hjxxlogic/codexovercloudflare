import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Local-only overlay: never supplies a production database or changes the
// checked-in deployment target. Remote deployments use deploy-cloud.py.
export function localStateConfig(output: string) {
  const config = JSON.parse(
    readFileSync('wrangler.jsonc', 'utf8').replace(/,(\s*[}\]])/g, '$1'),
  );
  config.main = resolve(config.main);
  config.assets.directory = resolve(config.assets.directory);
  config.vars.STATE_BACKEND = 'd1';
  config.d1_databases = [
    {
      binding: 'STATE_DB',
      database_name: 'coc-local-state',
      database_id: '00000000-0000-0000-0000-000000000001',
      migrations_dir: resolve('migrations/d1'),
    },
  ];
  config.triggers = { crons: ['17 * * * *'] };
  writeFileSync(output, JSON.stringify(config, null, 2) + '\n');
  return output;
}

// Vite clears generated assets; retain the separately prepared native downloads.
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const temporary = mkdtempSync(join(tmpdir(), 'coc-downloads-'));
const downloads = 'dist/web/downloads';
const backup = join(temporary, 'downloads');
try {
  if (existsSync(downloads)) cpSync(downloads, backup, { recursive: true });
  execFileSync(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      'build',
      '--config',
      'apps/web/vite.config.ts',
    ],
    { stdio: 'inherit' },
  );
} finally {
  if (existsSync(backup)) cpSync(backup, downloads, { recursive: true });
  rmSync(temporary, { recursive: true });
}

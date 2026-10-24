import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { CodexProcess } from '../apps/agent/src/codex.ts';
const dir = mkdtempSync(join(tmpdir(), 'coc-real-codex-'));
console.log(execFileSync('codex', ['--version'], { encoding: 'utf8' }).trim());
const p = new CodexProcess(
  'codex',
  [],
  dir,
  'read-only',
  () => {},
  () => {},
);
try {
  await p.initialize();
  const result = await p.request('thread/start', {
    cwd: dir,
    sandbox: 'read-only',
    approvalPolicy: 'on-request',
    ephemeral: true,
  });
  if (!result.thread?.id) throw new Error('No thread returned');
  console.log(
    'PASS: real Codex initialize + thread/start, read-only temporary project. No model request sent.',
  );
} finally {
  p.close();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
}

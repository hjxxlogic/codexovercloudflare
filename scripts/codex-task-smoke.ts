// Explicit real-model test, confined to one temporary project and known file.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexProcess } from '../apps/agent/src/codex.ts';
const dir = mkdtempSync(join(tmpdir(), 'coc-real-task-'));
let completed!: () => void, failed!: (e: Error) => void;
const done = new Promise<void>((r, j) => {
  completed = r;
  failed = j;
});
void done.catch(() => {});
const p = new CodexProcess(
  'codex',
  [],
  dir,
  'workspace-write',
  (m) => {
    if (m.id !== undefined && m.method) {
      p.send({
        id: m.id,
        error: {
          code: -32000,
          message:
            'Unattended smoke test does not approve additional permissions',
        },
      });
      failed(new Error('Task requested interactive approval'));
    }
    if (m.method === 'turn/completed') {
      if (m.params?.turn?.status === 'completed') completed();
      else failed(new Error('Turn did not complete successfully'));
    }
  },
  () => failed(new Error('Codex exited before completion')),
);
const timer = setTimeout(
  () => failed(new Error('Real model task timed out')),
  120000,
);
try {
  await p.initialize();
  const r = await p.request('thread/start', {
    cwd: dir,
    sandbox: 'workspace-write',
    approvalPolicy: 'on-request',
    ephemeral: true,
  });
  await p.request('turn/start', {
    threadId: r.thread.id,
    input: [
      {
        type: 'text',
        text: 'Local integration smoke test. In the current working directory only, create proof.txt containing exactly coc-smoke-ok followed by a newline. Do not read any other project, access the network, or change any other files. Then stop.',
        text_elements: [],
      },
    ],
  });
  await done;
  if (readFileSync(join(dir, 'proof.txt'), 'utf8') !== 'coc-smoke-ok\n')
    throw new Error('Unexpected file content');
  console.log(
    'PASS: real Codex model turn created the expected file in an isolated temporary workspace.',
  );
} finally {
  clearTimeout(timer);
  p.close();
  await new Promise((r) => setTimeout(r, 300));
  rmSync(dir, { recursive: true, force: true });
}

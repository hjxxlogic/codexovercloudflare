// Real Agent and read-only deterministic Codex peer; no model or production state.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';
const root = mkdtempSync(join(tmpdir(), 'coc-history-recovery-'));
const server = createServer((_req, res) =>
  res
    .writeHead(200, {
      'Content-Type': 'application/json',
      'X-CoC-Demand': '1',
      'X-CoC-Delivery': '2',
    })
    .end(JSON.stringify({ pending: [] })),
);
const sockets = new WebSocketServer({ server });
let peer: WebSocket | undefined;
let output = '';
const replies = new Map<string, any>();
sockets.on('connection', (ws) => {
  ws.send(
    JSON.stringify({
      type: 'hello',
      delivery: 2,
      minProtocol: 1,
      demand: 1,
      epoch: 1,
    }),
  );
  ws.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    if (message.type === 'capabilities') peer = ws;
    if (message.type === 'result') replies.set(message.requestId, message);
  });
});
async function until(predicate: () => boolean, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < end, 'Timed out: ' + output.slice(-1000));
    await new Promise((r) => setTimeout(r, 10));
  }
}
const executable = (name: string) =>
  resolve('build', name + (process.platform === 'win32' ? '.exe' : ''));
let child: ReturnType<typeof spawn> | undefined;
try {
  const seeded = spawnSync(
    executable('coc-history-source-tests'),
    ['--seed-unprepared', root],
    { encoding: 'utf8' },
  );
  assert.equal(seeded.status, 0, seeded.stderr);
  const reference = JSON.parse(seeded.stdout);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const config = join(root, 'agent.json');
  writeFileSync(
    config,
    JSON.stringify({
      relayUrl: `http://127.0.0.1:${(server.address() as any).port}`,
      hostId: 'host',
      token: 'history-recovery-test-credential',
      dataDir: join(root, 'state'),
      autoUpdate: false,
      projects: [{ id: 'project', name: 'Project', path: root }],
      codexPath: process.execPath,
      codexArgs: [resolve('tests/fixtures/history-source-peer.mjs')],
      historyStorage: {
        cacheMaxBytes: 0,
        readConcurrency: 1,
        readPageMaxBytes: 65536,
        minFreeDiskBytes: 1,
      },
    }),
    { mode: 0o600 },
  );
  child = spawn(
    executable('coc-agent'),
    ['run', '--config', config, '--proxy', ''],
    {
      env: { ...process.env, CODEX_HOME: join(root, '.codex') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout?.on('data', (b) => {
    output += String(b);
  });
  child.stderr?.on('data', (b) => {
    output += String(b);
  });
  await until(() => Boolean(peer));
  const database = new DatabaseSync(join(root, 'state', 'agent.db'));
  try {
    await until(
      () =>
        Boolean(
          database
            .prepare('SELECT recovery FROM history WHERE seq=?')
            .get(reference.seq)?.recovery,
        ),
      45000,
    );
    await until(
      () => database.prepare('SELECT COUNT(*) AS n FROM chunks').get()?.n === 0,
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS n FROM history').get()?.n,
      1,
    );
    assert.equal(
      database.prepare('SELECT COUNT(*) AS n FROM events').get()?.n,
      0,
    );
  } finally {
    database.close();
  }
  async function read(extra: Record<string, unknown> = {}) {
    const requestId = randomUUID();
    peer!.send(
      JSON.stringify({
        type: 'control',
        requestId,
        action: 'history',
        data: {
          sessionId: reference.sessionId,
          operation: 'content',
          seq: reference.seq,
          reference,
          offset: 0,
          ...extra,
        },
      }),
    );
    await until(() => replies.has(requestId));
    return replies.get(requestId);
  }
  const [first, busy] = await Promise.all([read(), read()]);
  assert.equal(first.error, undefined, JSON.stringify(first.error));
  const characters = Array.from('你好🙂'.repeat(2000));
  assert.equal(first.data.text, characters.slice(0, 4096).join(''));
  assert.equal(first.data.nextOffset, 4096);
  assert.equal(busy.error.code, 'BACKPRESSURE');
  const page = await read({ offset: 1 });
  assert.equal(page.data.text, characters.slice(1, 4097).join(''));
  assert.equal(page.data.more, true);
  const tail = await read({ offset: 4096 });
  assert.equal(tail.data.text, characters.slice(4096).join(''));
  assert.equal(tail.data.more, false);
  const invalid = await read({
    reference: {
      ...reference,
      digest: 'a'.repeat(64),
      contentId: 'a'.repeat(64),
    },
  });
  assert.equal(invalid.error.code, 'CONTENT_UNAVAILABLE');
  const path = join(root, '.codex', 'session.jsonl');
  renameSync(path, path + '.original');
  writeFileSync(path, 'replacement');
  assert.equal((await read()).error.code, 'DELIVERY_STATE_MISMATCH');
  rmSync(path);
  renameSync(path + '.original', path);
  assert.equal((await read()).data.text, characters.slice(0, 4096).join(''));
  console.log(
    'PASS: native history cache-miss recovery, Unicode paging, immutable reference, source replacement and bounded readers',
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child!.once('exit', r));
  }
  for (const ws of sockets.clients) ws.terminate();
  await new Promise<void>((r) => sockets.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}

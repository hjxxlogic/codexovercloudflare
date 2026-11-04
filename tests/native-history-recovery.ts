import { AgentEndpoint } from './helpers/agent-endpoint.ts';
// Real Agent and read-only deterministic Codex peer; no model or production state.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
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
let peer: AgentEndpoint | undefined;
let output = '';
const replies = new Map<string, any>();
sockets.on('connection', (rawSocket) => {
  const ws = new AgentEndpoint(rawSocket, 'host');

  ws.on('close', () => {
    if (peer === ws) peer = undefined;
  });
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
    [
      process.argv.includes('--file-started')
        ? '--seed-file-started'
        : process.argv.includes('--file')
          ? '--seed-file'
          : process.argv.includes('--inline')
            ? '--seed-inline'
            : '--seed-unprepared',
      root,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(seeded.status, 0, seeded.stderr);
  const reference = JSON.parse(seeded.stdout);
  let fileBody: string | undefined;
  if (
    process.argv.includes('--file') ||
    process.argv.includes('--file-started')
  ) {
    const fixture = new DatabaseSync(join(root, 'state', 'agent.db'));
    fileBody = String(
      fixture
        .prepare('SELECT value FROM history WHERE seq=?')
        .get(reference.seq)!.value,
    );
    fixture.close();
  }
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
        retainedRecords: process.argv.includes('--retention') ? 1 : 0,
        readConcurrency: 1,
        readPageMaxBytes: 65536,
        minFreeDiskBytes: 1,
      },
    }),
    { mode: 0o600 },
  );
  async function startAgent() {
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
  }
  await startAgent();
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
    await until(
      () =>
        database
          .prepare(
            "SELECT json_extract(value,'$.contentSeq') AS seq FROM history WHERE seq=?",
          )
          .get(reference.seq)?.seq === reference.seq,
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
  const characters = Array.from(
    fileBody ??
      (process.argv.includes('--inline')
        ? 'a你🙂'.repeat(1400)
        : '你好🙂'.repeat(2000)),
  );
  assert.equal(first.data.text, characters.slice(0, 4096).join(''));
  assert.equal(first.data.nextOffset, 4096);
  assert.equal(busy.error.code, 'BACKPRESSURE');
  const page = await read({ offset: 1 });
  assert.equal(page.data.text, characters.slice(1, 4097).join(''));
  assert.equal(page.data.more, true);
  const tail = await read({ offset: 4096 });
  assert.equal(tail.data.text, characters.slice(4096).join(''));
  assert.equal(tail.data.more, false);
  const clientOwner = 'a'.repeat(64);
  const clientPage = await read({
    operation: 'page',
    historyVersion: 2,
    owner: clientOwner,
  });
  assert.equal(clientPage.error, undefined, JSON.stringify(clientPage.error));
  const clientReference = clientPage.data.events.find(
    (event: any) => event.seq === reference.seq,
  )?.contentReference;
  assert(
    clientReference?.recovery,
    'History page must hand recovery evidence to the client',
  );
  const stateBeforeRestart = new DatabaseSync(join(root, 'state', 'agent.db'));
  const retained = stateBeforeRestart
    .prepare('SELECT value,revision,recovery FROM history WHERE seq=?')
    .get(reference.seq);
  stateBeforeRestart.close();
  const oldChild = child!;
  const oldPid = oldChild.pid;
  const stopped = new Promise((r) => oldChild.once('exit', r));
  oldChild.kill('SIGKILL');
  await stopped;
  await until(() => peer === undefined);
  await startAgent();
  assert.notEqual(child!.pid, oldPid);
  const restartedFirst = await read();
  const restartedTail = await read({ offset: 4096 });
  assert.equal(
    restartedFirst.error,
    undefined,
    JSON.stringify(restartedFirst.error),
  );
  assert.equal(restartedFirst.data.text, characters.slice(0, 4096).join(''));
  assert.equal(restartedTail.data.text, characters.slice(4096).join(''));
  assert.equal(restartedTail.data.more, false);
  const stateAfterRestart = new DatabaseSync(join(root, 'state', 'agent.db'));
  assert.deepEqual(
    stateAfterRestart
      .prepare('SELECT value,revision,recovery FROM history WHERE seq=?')
      .get(reference.seq),
    retained,
  );
  assert.equal(
    stateAfterRestart.prepare('SELECT COUNT(*) AS n FROM chunks').get()?.n,
    0,
  );
  stateAfterRestart.close();
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
  if (process.argv.includes('--retention')) {
    // Only this isolated fixture receives synthetic extra history; no business request is replayed.
    const fixture = new DatabaseSync(join(root, 'state', 'agent.db'));
    const next =
      Number(
        fixture
          .prepare(
            'SELECT revision FROM transport2_history_heads WHERE session=?',
          )
          .get(reference.sessionId)!.revision,
      ) + 1;
    fixture
      .prepare(
        "UPDATE sessions SET value=json_set(value,'$.external',json('true')) WHERE id=?",
      )
      .run(reference.sessionId);
    fixture
      .prepare(
        'INSERT INTO history(seq,session,value,revision) VALUES(?,?,?,?)',
      )
      .run(
        next,
        reference.sessionId,
        JSON.stringify({
          seq: next,
          revision: next,
          type: 'user',
          data: { text: 'retained tail' },
        }),
        next,
      );
    const subscription = {
      operation: 'subscribe',
      owner: 'reader',
      route: 'retention-route',
      stream: 'retention-stream',
      instance: 'retention-client',
      exchangeId: 'retention-exchange',
      receivedRevision: 0,
      acknowledgedRevision: 0,
    };
    const opened = await read(subscription);
    assert.equal(opened.error, undefined, JSON.stringify(opened.error));
    const ack = {
      ...subscription,
      operation: 'ack',
      receivedRevision: next,
      releasedRevision: next,
      agentInstance: opened.data.agentInstance,
      streamSerial: opened.data.streamSerial,
      creditGeneration: opened.data.creditGeneration,
    };
    assert.equal((await read(ack)).data.releasedRevision, next);
    await until(
      () =>
        Number(
          fixture
            .prepare(
              'SELECT generation FROM transport2_history_heads WHERE session=?',
            )
            .get(reference.sessionId)!.generation,
        ) > 0,
      70000,
    );
    fixture.close();
    assert.equal((await read()).error.code, 'CONTENT_EXPIRED');
    const recoveredFromClient = await read({
      reference: clientReference,
      owner: clientOwner,
    });
    assert.equal(
      recoveredFromClient.error,
      undefined,
      JSON.stringify(recoveredFromClient.error),
    );
    assert.equal(
      recoveredFromClient.data.text,
      characters.slice(0, 4096).join(''),
    );
    assert.equal(
      (await read({ reference: clientReference, owner: 'b'.repeat(64) })).error
        .code,
      'FORBIDDEN',
    );
    assert.equal(
      (
        await read({
          reference: {
            ...clientReference,
            recovery: {
              ...clientReference.recovery,
              payload: clientReference.recovery.payload + ' ',
            },
          },
          owner: clientOwner,
        })
      ).error.code,
      'FORBIDDEN',
    );
    const gap = await read({ operation: 'page', historyVersion: 2, after: 0 });
    assert.equal(gap.data.gap, true);
    assert.equal(gap.data.events.length, 1);
    assert.equal(gap.data.snapshotSeq, next);
    const stale = await read({
      operation: 'page',
      historyVersion: 2,
      after: 0,
      snapshotGeneration: 0,
    });
    assert.equal(stale.error.code, 'HISTORY_SNAPSHOT_CHANGED');
    assert.equal(
      (await read({ operation: 'page', historyVersion: 1, after: 0 })).error
        .code,
      'UNSUPPORTED_PROTOCOL_VERSION',
    );
  }
  console.log(
    'PASS: native history cache-miss recovery, Unicode paging, immutable reference, source replacement, bounded readers and SIGKILL restart' +
      (process.argv.includes('--retention')
        ? ', scheduled retirement, expired references, client-held recovery credentials, owner/MAC isolation and versioned gap recovery'
        : ''),
  );
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill();
    await new Promise((r) => child!.once('exit', r));
  }
  for (const ws of sockets.clients) ws.terminate();
  await new Promise<void>((r) => sockets.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}

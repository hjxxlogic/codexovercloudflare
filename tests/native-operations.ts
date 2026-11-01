// Real endpoint receipts, process death and recovery; no cloud or model calls.
import assert from 'node:assert/strict';
import uploadFixtures from './upload-binding-fixtures.json';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';

const root = mkdtempSync(join(tmpdir(), 'coc-operations-'));
const config = join(root, 'agent.json');
const frames: any[] = [];
let child: ChildProcess | undefined;
let peer: WebSocket | undefined;
let log = '';
let database: DatabaseSync | undefined;
const server = createServer((_request, response) =>
  response
    .writeHead(200, {
      'Content-Type': 'application/json',
      'X-CoC-Demand': '1',
      'X-CoC-Delivery': '2',
    })
    .end(JSON.stringify({ pending: [] })),
);
const sockets = new WebSocketServer({ server });
sockets.on('connection', (socket) => {
  socket.send(
    JSON.stringify({
      type: 'hello',
      delivery: 2,
      minProtocol: 1,
      demand: 1,
      epoch: 1,
    }),
  );
  socket.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    if (frame.type === 'capabilities') peer = socket;
  });
  socket.on('close', () => {
    if (peer === socket) peer = undefined;
  });
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const settings = {
  relayUrl: `http://127.0.0.1:${(server.address() as any).port}`,
  hostId: 'host',
  token: 'original-operation-test-credential',
  dataDir: join(root, 'state'),
  autoUpdate: false,
  projects: [{ id: 'project', name: 'Project', path: root }],
  codexPath: process.execPath,
  codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
};
async function until(predicate: () => any) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Timed out: ' + log.slice(-2500));
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function start() {
  writeFileSync(config, JSON.stringify(settings), { mode: 0o600 });
  child = spawn(resolve('build/coc-agent'), ['run', '--config', config], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (data) => (log += data));
  child.stderr!.on('data', (data) => (log += data));
  await until(() => peer);
}
async function stop(signal: NodeJS.Signals = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((done) => child!.once('close', done));
  child.kill(signal);
  const timer = setTimeout(() => child!.kill('SIGKILL'), 10000);
  await closed;
  clearTimeout(timer);
  peer = undefined;
}
function send(action: string, data: unknown, intent?: unknown) {
  const requestId = randomUUID();
  assert(peer);
  peer.send(
    JSON.stringify({
      type: 'control',
      action,
      data,
      requestId,
      ...(intent ? { intent } : {}),
    }),
  );
  return requestId;
}
async function result(requestId: string) {
  await until(() =>
    frames.some(
      (frame) => frame.type === 'result' && frame.requestId === requestId,
    ),
  );
  return frames.find(
    (frame) => frame.type === 'result' && frame.requestId === requestId,
  );
}
async function control(action: string, data: unknown, intent?: unknown) {
  return result(send(action, data, intent));
}
try {
  await start();
  database = new DatabaseSync(join(root, 'state', 'agent.db'));
  const count = () =>
    Number(database!.prepare('SELECT COUNT(*) AS n FROM sessions').get()!.n);
  const probe = await control('probe', {});
  const instance = probe.data.deliveryInstance;
  assert.equal(
    instance,
    frames.find((frame) => frame.type === 'capabilities').deliveryInstance,
  );
  for (const [action, args] of [
    ['create', { projectId: 'project', mode: 'web' }],
    ['stop', { sessionId: 'host~missing' }],
    [
      'queue',
      {
        sessionId: 'host~missing',
        mode: 'web',
        requestId: 'unbound',
        text: 'must not run',
      },
    ],
    ['answer', { sessionId: 'host~missing', mode: 'web' }],
    ['projectManage', { operation: 'add', id: 'must-not-exist', path: root }],
    [
      'files',
      {
        operation: 'begin',
        projectId: 'project',
        owner: 'a'.repeat(64),
        uploadId: 'must-not-exist',
        path: 'unbound',
        size: 0,
      },
    ],
    [
      'files',
      {
        operation: 'finish',
        projectId: 'project',
        owner: 'a'.repeat(64),
        uploadId: 'must-not-exist',
      },
    ],
  ] as const) {
    const before = count();
    const refused = await control(action, args);
    assert.equal(refused.error.code, 'UPGRADE_REQUIRED');
    assert.equal(refused.intent, undefined);
    assert.equal(count(), before);
  }
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM transport2_operations').get()!
      .n,
    0,
  );
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM transport2_uploads').get()!.n,
    0,
  );
  assert.equal(
    (await control('request', { requestId: 'legacy' })).error.code,
    'UNSUPPORTED_ACTION',
  );
  for (const fixture of uploadFixtures.filter((entry) => entry.error)) {
    const args = {
      ...fixture.input,
      projectId: 'project',
      owner: 'a'.repeat(64),
    };
    const original = ['begin', 'finish'].includes(args.operation)
      ? { requestId: randomUUID(), owner: args.owner, instance }
      : undefined;
    // The shared fixture's valid binding must match this real Agent journal.
    if (args.agentInstance === 'agent-store') args.agentInstance = instance;
    const rejected = await control('files', args, original);
    assert.equal(rejected.error.code, 'INVALID_REQUEST', fixture.name);
    if (original) {
      const ack = await control('files', args, { ...original, ack: true });
      assert.equal(ack.data.confirmed, true);
    }
  }
  for (const operation of ['chunk', 'finish', 'cancel', 'status']) {
    const args = {
      operation,
      projectId: 'project',
      owner: 'a'.repeat(64),
      uploadId: 'foreign',
      agentInstance: 'another-store',
      sha256: 'a'.repeat(64),
      offset: 0,
      data: 'YWJj',
    };
    const original =
      operation === 'finish'
        ? { requestId: randomUUID(), owner: args.owner, instance }
        : undefined;
    assert.equal(
      (await control('files', args, original)).error.code,
      'DELIVERY_STATE_MISMATCH',
    );
    if (original) await control('files', args, { ...original, ack: true });
  }
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM transport2_uploads').get()!.n,
    0,
    'Malformed or foreign-instance upload commands cannot allocate staging promises',
  );
  const intent = { requestId: randomUUID(), owner: 'a'.repeat(64), instance };
  const data = { key: 'original-create', projectId: 'project', mode: 'web' };
  const created = await control('create', data, intent);
  assert(!created.error, JSON.stringify(created.error));
  assert.deepEqual(created.intent, intent);
  const originalCount = count();
  // Drop the wire result and retry under a fresh forwarding correlation.
  const repeated = await control('create', data, intent);
  assert.deepEqual(repeated.data, created.data);
  assert.deepEqual(repeated.intent, intent);
  assert.equal(count(), originalCount);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('requests','request_states')",
      )
      .get()!.n,
    0,
    'Creating sessions uses only the original operation ledger',
  );
  const conflict = await control(
    'create',
    { ...data, projectId: 'other' },
    intent,
  );
  assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(conflict.intent, undefined);
  const wrongInstance = await control('create', data, {
    ...intent,
    instance: 'another-store',
  });
  assert.equal(wrongInstance.error.code, 'DELIVERY_STATE_MISMATCH');
  const invalidRead = await control(
    'probe',
    {},
    { ...intent, requestId: randomUUID() },
  );
  assert.equal(invalidRead.error.code, 'INVALID_REQUEST');

  await stop();
  const hold = join(root, 'hold-codex.mjs');
  writeFileSync(
    hold,
    `import {createInterface} from 'node:readline';
if (process.argv.includes('--version')) {console.log('codex-cli 0.164.0'); process.exit(0);}
createInterface({input:process.stdin}).on('line',()=>{});
`,
  );
  settings.codexArgs = [hold];
  await start();
  // The restarted Agent must return the exact earlier result without launching Codex.
  const recovered = await control('create', data, intent);
  assert.deepEqual(recovered.data, created.data);
  assert.equal(count(), originalCount);
  const uncertain = { ...intent, requestId: randomUUID() };
  const uncertainData = { ...data, key: 'crash-original-create' };
  const lost = send('create', uncertainData, uncertain);
  await until(() => count() === originalCount + 1);
  assert.equal(
    frames.some((frame) => frame.requestId === lost),
    false,
  );
  const pending = await control('create', uncertainData, uncertain);
  assert.equal(pending.error.code, 'RESULT_PENDING');
  assert.equal(pending.intent, undefined);
  const premature = await control('create', uncertainData, {
    ...uncertain,
    ack: true,
  });
  assert.equal(premature.error.code, 'RESULT_PENDING');
  await stop('SIGKILL');
  settings.codexArgs = [resolve('tests/fixtures/fake-codex.mjs')];
  await start();
  const unknown = await control('create', uncertainData, uncertain);
  assert.equal(unknown.error.code, 'RESULT_UNKNOWN');
  assert.deepEqual(unknown.intent, uncertain);
  assert.equal(
    count(),
    originalCount + 1,
    'Unknown effects are never dispatched again',
  );
  const acked = await control('create', data, { ...intent, ack: true });
  assert.deepEqual(acked.data, { confirmed: true });
  assert.deepEqual(acked.intent, { ...intent, ack: true });
  const retired = await control('create', data, intent);
  assert.equal(retired.error.code, 'RESULT_UNAVAILABLE');
  await control('create', uncertainData, { ...uncertain, ack: true });
  const rows = database
    .prepare('SELECT phase,result,reserved FROM transport2_operations')
    .all();
  assert(
    rows.every(
      (row) =>
        row.phase === 'acked' && row.result === null && row.reserved === 8192,
    ),
  );
  assert.equal(count(), originalCount + 1);
  console.log(
    'PASS: real Agent original results, wire loss, duplicate dispatch refusal, instance fencing, process death, durable uncertainty and result confirmation',
  );
} finally {
  await stop();
  database?.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((done) =>
    sockets.close(() => server.close(() => done())),
  );
  rmSync(root, { recursive: true, force: true });
}

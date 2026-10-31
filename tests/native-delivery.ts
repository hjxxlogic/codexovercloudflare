// Real native Agent, deterministic Codex peer; no model calls or production state.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer, type WebSocket } from 'ws';
const root = mkdtempSync(join(tmpdir(), 'coc-delivery-'));
const frames: any[] = [];
let peer: WebSocket | undefined;
let child: ChildProcess | undefined;
let database: DatabaseSync | undefined;
let log = '';
const server = createServer((_request, response) =>
  response
    .writeHead(200, { 'Content-Type': 'application/json', 'X-CoC-Demand': '1' })
    .end(JSON.stringify({ pending: [] })),
);
const sockets = new WebSocketServer({ server });
sockets.on('connection', (ws) => {
  ws.send(
    JSON.stringify({ type: 'hello', minProtocol: 1, demand: 1, epoch: 1 }),
  );
  ws.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    if (frame.type === 'capabilities') {
      assert.equal(frame.delivery, 1);
      peer = ws;
    }
  });
  ws.on('close', () => {
    if (peer === ws) peer = undefined;
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const relay = `http://127.0.0.1:${(server.address() as any).port}`;
const config = join(root, 'agent.json');
writeFileSync(
  config,
  JSON.stringify({
    relayUrl: relay,
    hostId: 'host',
    token: 'delivery-test-credential',
    dataDir: join(root, 'state'),
    autoUpdate: false,
    projects: [{ id: 'project', name: 'Project', path: root }],
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
  }),
  { mode: 0o600 },
);
async function until(predicate: () => any) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Timed out: ' + log.slice(-1500));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function send(frame: unknown) {
  assert(peer);
  peer.send(JSON.stringify(frame));
}
async function control(action: string, data: unknown = {}) {
  const requestId = randomUUID();
  send({ type: 'control', requestId, action, data });
  await until(() =>
    frames.some(
      (frame) => frame.type === 'result' && frame.requestId === requestId,
    ),
  );
  const result = frames.find(
    (frame) => frame.type === 'result' && frame.requestId === requestId,
  );
  assert(!result.error, JSON.stringify(result.error));
  return result.data;
}
function mutation(
  sessionId: string,
  stream: string,
  lane: string,
  seq: number,
  end: number,
  payload: any,
  mode = 'web',
  epoch = 1,
) {
  const body = JSON.stringify(payload);
  send({
    type: mode === 'cli' ? 'rpc' : 'web',
    sessionId,
    epoch,
    payload,
    delivery: { stream, lane, seq, end: end + Buffer.byteLength(body), body },
  });
  return end + Buffer.byteLength(body);
}
async function open(
  sessionId: string,
  mode: string,
  stream: string,
  lane = 'normal',
) {
  return control('delivery', { sessionId, mode, stream, lane });
}
try {
  child = spawn(
    resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent'),
    ['run', '--config', config],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout!.on('data', (data) => (log += data));
  child.stderr!.on('data', (data) => (log += data));
  await until(() => peer);
  database = new DatabaseSync(join(root, 'state', 'agent.db'));
  const web = await control('create', {
    key: 'create-web',
    projectId: 'project',
    mode: 'web',
  });
  await control('attach', {
    sessionId: web.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  await open(web.id, 'web', 'web-normal');
  const prompt = {
    action: 'prompt',
    requestId: 'exact-task',
    text: 'delivery proof',
  };
  const bytes = mutation(web.id, 'web-normal', 'normal', 1, 0, prompt);
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === web.id && frame.payload?.type === 'delivery-result',
    ),
  );
  // Simulate losing the result at the client: query durable state, then duplicate the exact command.
  const result = await control('delivery', {
    sessionId: web.id,
    mode: 'web',
    stream: 'web-normal',
    lane: 'normal',
    seq: 1,
  });
  assert.equal(result.record.phase, 'finished');
  assert.equal(result.record.result.requestId, 'exact-task');
  mutation(web.id, 'web-normal', 'normal', 1, 0, prompt);
  await control('probe');
  const snapshot = await control('snapshot', {
    sessionId: web.id,
    mode: 'web',
  });
  assert.equal(
    snapshot.history.events.filter(
      (event: any) =>
        event.type === 'user' && event.data.requestId === 'exact-task',
    ).length,
    1,
  );
  assert.equal(
    (await open(web.id, 'web', 'web-normal')).window.receivedBytes,
    bytes,
  );
  const cli = await control('create', {
    key: 'create-cli',
    projectId: 'project',
    mode: 'cli',
  });
  await control('attach', {
    sessionId: cli.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  await open(cli.id, 'cli', 'cli-normal');
  send({
    type: 'delivery-output',
    sessionId: cli.id,
    epoch: 1,
    received: 0,
    credit: 1,
    byteCredit: 0,
    replay: true,
  });
  mutation(
    cli.id,
    'cli-normal',
    'normal',
    1,
    0,
    {
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'delivery-test', version: '1' } },
    },
    'cli',
  );
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === cli.id && frame.payload?.type === 'delivery-result',
    ),
  );
  send({
    type: 'rpc',
    sessionId: cli.id,
    epoch: 1,
    payload: { id: 2, method: 'model/list', params: {} },
  });
  await until(
    () =>
      Number(
        database!
          .prepare('SELECT sent FROM delivery_output_heads WHERE stream=?')
          .get('rpc-output:' + cli.id)?.sent,
      ) === 1,
  );
  const firstEnd = Number(
    database!
      .prepare(
        'SELECT end_bytes FROM delivery_outputs WHERE stream=? AND seq=1',
      )
      .get('rpc-output:' + cli.id)?.end_bytes,
  );
  send({
    type: 'delivery-output',
    sessionId: cli.id,
    epoch: 1,
    received: 0,
    credit: 1,
    byteCredit: firstEnd,
  });
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === cli.id &&
        frame.payload?.type === 'delivery-data' &&
        frame.payload.seq === 1,
    ),
  );
  const first = frames.find(
    (frame) =>
      frame.sessionId === cli.id && frame.payload?.type === 'delivery-data',
  ).payload;
  send({
    type: 'rpc',
    sessionId: cli.id,
    epoch: 1,
    payload: { id: 3, method: 'model/list', params: {} },
  });
  await until(
    () =>
      Number(
        database!
          .prepare('SELECT sent FROM delivery_output_heads WHERE stream=?')
          .get('rpc-output:' + cli.id)?.sent,
      ) === 2,
  );
  await control('probe');
  assert(
    !frames.some(
      (frame) =>
        frame.sessionId === cli.id &&
        frame.payload?.type === 'delivery-data' &&
        frame.payload.seq === 2,
    ),
    'No output beyond granted slots',
  );
  send({
    type: 'delivery-output',
    sessionId: cli.id,
    epoch: 1,
    received: 1,
    credit: 2,
    byteCredit: first.end + 1,
  });
  await control('probe');
  assert(
    !frames.some(
      (frame) =>
        frame.sessionId === cli.id &&
        frame.payload?.type === 'delivery-data' &&
        frame.payload.seq === 2,
    ),
    'Byte credit also bounds output',
  );
  send({
    type: 'delivery-output',
    sessionId: cli.id,
    epoch: 1,
    received: 1,
    credit: 2,
    byteCredit: first.end + 2 * 1024 * 1024,
  });
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === cli.id &&
        frame.payload?.type === 'delivery-data' &&
        frame.payload.seq === 2,
    ),
  );
  await control('attach', {
    sessionId: cli.id,
    epoch: 2,
    expires: Date.now() + 15000,
    deliveryResume: 'cli-normal',
  });
  send({
    type: 'delivery-output',
    sessionId: cli.id,
    epoch: 2,
    received: 1,
    credit: 33,
    byteCredit: first.end + 2 * 1024 * 1024,
    replay: true,
  });
  await until(
    () =>
      frames.filter(
        (frame) =>
          frame.sessionId === cli.id &&
          frame.payload?.type === 'delivery-data' &&
          frame.payload.seq === 2,
      ).length === 2,
  );
  const copies = frames.filter(
    (frame) =>
      frame.sessionId === cli.id &&
      frame.payload?.type === 'delivery-data' &&
      frame.payload.seq === 2,
  );
  assert.equal(copies[0].payload.body, copies[1].payload.body);
  assert.equal(JSON.parse(copies[1].payload.body).id, 3);
  console.log(
    'PASS: native durable command/result recovery, exactly one task, output slot/byte credit and same-runtime CLI replay',
  );
} finally {
  database?.close();
  if (child && child.exitCode === null) {
    const closed = new Promise((resolve) => child!.once('close', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child!.kill('SIGKILL'), 10000);
    await closed;
    clearTimeout(timer);
  }
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((done) =>
    sockets.close(() => server.close(() => done())),
  );
  rmSync(root, { recursive: true, force: true });
}

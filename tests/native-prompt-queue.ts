// Real native Agent, deterministic Codex peer; no model calls or production state.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { operationWrite } from '../packages/protocol/src/index.ts';
import { WebSocketServer, type WebSocket } from 'ws';
const root = mkdtempSync(join(tmpdir(), 'coc-delivery-'));
mkdirSync(join(root, 'window'));
const projectRoot = join(root, 'project');
mkdirSync(projectRoot);
const frames: any[] = [];
let peer: WebSocket | undefined;
let child: ChildProcess | undefined;
let database: DatabaseSync | undefined;
let log = '';
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
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    if (frame.type === 'capabilities') {
      assert.equal(frame.delivery, 2);
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
    externalSessions: { allowQueue: true },
    projects: [
      { id: 'project', name: 'Project', path: projectRoot },
      { id: 'window', name: 'Window test', path: join(root, 'window') },
    ],
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
  }),
  { mode: 0o600 },
);
async function until(predicate: () => any, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Timed out: ' + log.slice(-1500));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
function allocation(stream: string) {
  const window = frames
    .map((frame) => frame.data?.window ?? frame.payload?.window)
    .reverse()
    .find((window: any) => window?.stream === stream);
  assert(window, 'An original receiver allocation must exist before sending');
  return {
    instance: window.instance,
    streamSerial: window.streamSerial,
    creditGeneration: window.creditGeneration,
  };
}
function send(frame: any) {
  assert(peer);
  if (frame.delivery)
    frame = {
      ...frame,
      delivery: { ...allocation(frame.delivery.stream), ...frame.delivery },
    };
  if (frame.type === 'delivery-receipt')
    frame = { ...allocation(frame.stream), ...frame };
  peer.send(JSON.stringify(frame));
}
async function control(action: string, data: unknown = {}) {
  if (action === 'delivery') {
    const command = data as any;
    const known = frames.some(
      (frame) =>
        (frame.data?.window ?? frame.payload?.window)?.stream ===
        command.stream,
    );
    if (!command.exchangeId || known)
      data = { ...allocation(command.stream), ...command };
  }
  const requestId = randomUUID();
  const args = data as any;
  const intent = operationWrite(action, args)
    ? {
        requestId: args.key || args.requestId || requestId,
        owner: 'a'.repeat(64),
        instance: (await control('probe')).operationInstance,
      }
    : undefined;
  send({
    type: 'control',
    requestId,
    action,
    data,
    ...(intent ? { intent } : {}),
  });
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
let queueEpoch = 1;
async function open(
  sessionId: string,
  mode: string,
  stream: string,
  lane = 'normal',
  generation = queueEpoch,
) {
  const exchangeId = randomUUID();
  const result = await control('delivery', {
    sessionId,
    mode,
    stream,
    lane,
    exchangeId,
    control: {
      controlEpoch: queueEpoch,
      connectionGeneration: generation,
      controlId: 'claim-' + mode,
      owner: 'client',
    },
  });
  assert.equal(result.exchangeId, exchangeId);
  return result;
}

function startAgent() {
  child = spawn(
    resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent'),
    ['run', '--config', config],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout!.on('data', (data) => (log += data));
  child.stderr!.on('data', (data) => (log += data));
}
async function stopAgent() {
  const closed = new Promise((resolve) => child!.once('close', resolve));
  child!.kill('SIGKILL');
  await closed;
  await until(() => !peer);
}
try {
  startAgent();
  await until(() => peer);
  database = new DatabaseSync(join(root, 'state', 'agent.db'));
  let session = await control('create', {
    key: 'queue-session',
    projectId: 'project',
    mode: 'web',
  });
  await control('attach', {
    sessionId: session.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  await open(session.id, 'web', 'queue-normal');
  await open(session.id, 'web', 'queue-priority', 'priority');
  let queuePrefix = 'queue';
  let normalSeq = 0,
    normalEnd = 0,
    prioritySeq = 0,
    priorityEnd = 0;
  const state = () =>
    JSON.parse(
      String(
        database!
          .prepare('SELECT value FROM sessions WHERE id=?')
          .get(session.id)!.value,
      ),
    );
  const snapshot = () =>
    control('snapshot', { sessionId: session.id, mode: 'web' });
  async function command(action: string, data: any = {}, priority = false) {
    const lane = priority ? 'priority' : 'normal';
    const stream = queuePrefix + '-' + lane;
    const seq = priority ? ++prioritySeq : ++normalSeq;
    const before = priority ? priorityEnd : normalEnd;
    const payload = {
      action,
      requestId: 'request-' + lane + '-' + seq,
      ...data,
    };
    const epoch = queueEpoch;
    const end = mutation(
      session.id,
      stream,
      lane,
      seq,
      before,
      payload,
      'web',
      epoch,
    );
    if (priority) priorityEnd = end;
    else normalEnd = end;
    await until(
      () =>
        database!
          .prepare(
            'SELECT phase FROM transport2_commands WHERE stream=? AND seq=?',
          )
          .get(stream, seq)?.phase === 'finished',
    );
    const result = await control('delivery', {
      sessionId: session.id,
      mode: 'web',
      stream,
      lane,
      seq,
    });
    return {
      result: JSON.parse(result.record.resultBody),
      replay: () =>
        mutation(session.id, stream, lane, seq, before, payload, 'web', epoch),
    };
  }
  const users = () =>
    database!
      .prepare(
        "SELECT value FROM history WHERE session=? AND json_extract(value,'$.type')='user' ORDER BY seq",
      )
      .all(session.id)
      .map((row) => JSON.parse(String(row.value)).data.text);
  // Hold a real native turn while the queue is modified and recovered by direct reads.
  await command('prompt', { text: 'hold queue-test-delay' });
  await until(() => !!state().turnId);
  const first = await command('enqueue', {
    text: 'queued first',
    model: 'gpt-test',
  });
  assert.equal(first.result.result.state, 'queued-local');
  const firstId = first.result.result.queueId;
  first.replay();
  first.replay();
  await control('probe');
  assert.equal(
    state().promptQueue.length,
    1,
    'duplicate delivery cannot enqueue twice',
  );
  const second = await command('enqueue', { text: 'queued second' });
  const secondId = second.result.result.queueId;
  const third = await command('enqueue', { text: 'cancel this message' });
  await command('queueCancel', { queueId: third.result.result.queueId }, true);
  assert.deepEqual(
    (await snapshot()).session.promptQueue.map((entry: any) => entry.id),
    [firstId, secondId],
  );
  assert(!users().includes('queued first'), 'queue admission is not execution');
  const tooLarge = await command('enqueue', { text: '\\'.repeat(30000) });
  assert.equal(tooLarge.result.error.code, 'BACKPRESSURE');
  assert.equal(state().promptQueue.length, 2, 'byte limit refusal is atomic');
  // A second controller inherits the session queue, not the original command flow.
  queueEpoch = 2;
  await control('attach', {
    sessionId: session.id,
    epoch: queueEpoch,
    expires: Date.now() + 15000,
  });
  queuePrefix = 'takeover-queue';
  normalSeq = 0;
  normalEnd = 0;
  prioritySeq = 0;
  priorityEnd = 0;
  await open(session.id, 'web', queuePrefix + '-normal');
  await open(session.id, 'web', queuePrefix + '-priority', 'priority');
  // A stale immediate action must not interrupt a different turn.
  const rejected = await command(
    'queueRun',
    {
      queueId: secondId,
      target: { ...state().activeTask, turnId: 'wrong-turn' },
    },
    true,
  );
  assert.equal(rejected.result.error.code, 'TARGET_NOT_FOUND');
  const run = await command(
    'queueRun',
    { queueId: secondId, target: state().activeTask },
    true,
  );
  assert(!run.result.error);
  run.replay();
  assert.equal(state().promptQueue[0].state, 'stopping');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert(
    !users().includes('queued second'),
    'interrupt ACK is not turn completion',
  );
  await until(() => state().promptQueue.length === 0 && !state().running);
  assert.deepEqual(
    users().slice(-2),
    ['queued second', 'queued first'],
    'run now promotes one entry and preserves the rest',
  );
  assert(!users().includes('cancel this message'));
  assert.equal(users().filter((text) => text === 'queued second').length, 1);
  // Enqueue on an idle session starts automatically (including the UI busy/idle race).
  await command('enqueue', { text: 'idle enqueue' });
  await until(() => state().promptQueue.length === 0 && !state().running);
  assert(users().includes('idle enqueue'));
  // Waiting approvals belong to the interrupted turn, never its queued successor.
  await command('prompt', { text: 'approval queue hold' });
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === session.id &&
        frame.payload?.event?.type === 'approval',
    ),
  );
  assert.equal((await snapshot()).approvals.length, 1);
  const afterApproval = await command('enqueue', {
    text: 'queued successor',
  });
  await command(
    'queueRun',
    {
      queueId: afterApproval.result.result.queueId,
      target: state().activeTask,
    },
    true,
  );
  await until(() => state().promptQueue.length === 0 && !state().running);
  assert.equal((await snapshot()).approvals.length, 0);
  // A failed interrupt leaves the message pending and prevents automatic execution.
  await command('prompt', { text: 'hold queue-test-reject' });
  await until(() => !!state().turnId);
  const paused = await command('enqueue', { text: 'must remain queued' });
  await command(
    'queueRun',
    { queueId: paused.result.result.queueId, target: state().activeTask },
    true,
  );
  await until(() => state().promptQueue[0].state === 'failed');
  assert(!users().includes('must remain queued'));
  const retainedId = state().promptQueue[0].id;
  // Restart preserves unexecuted content and cannot replay the interrupted session.
  await stopAgent();
  startAgent();
  await until(() => peer);
  const recovered = await snapshot();
  assert.equal(recovered.session.state, 'failed');
  assert.equal(recovered.session.promptQueue[0].id, retainedId);
  assert.equal(recovered.session.promptQueue[0].text, 'must remain queued');
  assert(!users().includes('must remain queued'));
  queueEpoch = 1;
  session = await control('create', {
    key: 'unknown-queue-session',
    projectId: 'project',
    mode: 'web',
  });
  await control('attach', {
    sessionId: session.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  queuePrefix = 'unknown-queue';
  normalSeq = 0;
  normalEnd = 0;
  await open(session.id, 'web', queuePrefix + '-normal');
  await open(session.id, 'web', queuePrefix + '-priority', 'priority');
  await command('enqueue', { text: 'hold queue-test-unknown' });
  await until(
    () => state().promptQueue[0]?.state === 'starting' && !!state().turnId,
  );
  await command('enqueue', { text: 'retained behind unknown' });
  await stopAgent();
  startAgent();
  await until(() => peer);
  const uncertain = await snapshot();
  assert.equal(uncertain.session.promptQueue[0].state, 'unknown');
  assert.equal(uncertain.session.promptQueue[1].state, 'queued');
  assert.equal(
    users().filter((text) => text === 'hold queue-test-unknown').length,
    1,
  );
  assert(!users().includes('retained behind unknown'));
  console.log(
    'PASS: durable managed prompt queue, duplicate delivery, cancellation, priority selection, delayed turn completion, idle race, stop failure and restart preservation',
  );
} finally {
  database?.close();
  if (child && child.exitCode === null && child.signalCode === null) {
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

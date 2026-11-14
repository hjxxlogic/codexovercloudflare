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
    resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent-component'),
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
    send({
      type: 'delivery-receipt',
      sessionId: session.id,
      mode: 'web',
      stream,
      lane,
      received: result.record.resultSeq,
      receivedBytes: result.record.resultEnd,
    });
    await control('probe');
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
  // Child thread notifications cannot replace or complete the main active turn.
  await command('prompt', { text: 'hold child-agent-notifications' });
  await until(() =>
    database!
      .prepare(
        "SELECT 1 FROM history WHERE session=? AND json_extract(value,'$.type')='test/childNotificationsProcessed'",
      )
      .get(session.id),
  );
  assert.equal(state().running, true);
  assert.equal(state().turnId, 'turn-1');
  assert.equal(state().activeTask.turnId, 'turn-1');
  assert.equal(
    database!
      .prepare(
        "SELECT count(*) AS n FROM history WHERE session=? AND json_extract(value,'$.data.threadId')='child-thread'",
      )
      .get(session.id)!.n,
    0,
    'child messages and lifecycle events never enter main history',
  );
  assert.deepEqual((await snapshot()).session.contextUsage, {
    usedTokens: 112000,
    contextWindow: 212000,
  });
  const stopped = await command(
    'interrupt',
    { target: state().activeTask },
    true,
  );
  assert(!stopped.result.error, JSON.stringify(stopped.result));
  await until(() => !state().running);
  // Enqueued messages steer the current turn, without waiting for completion.
  await command('prompt', { text: 'hold running turn' });
  await until(() => !!state().turnId);
  const activeTurn = state().turnId;
  const activeTask = state().activeTask;
  const first = await command('enqueue', {
    text: 'first follow-up',
    model: 'gpt-test',
  });
  first.replay();
  first.replay();
  await command('enqueue', { text: 'second follow-up' });
  await until(() => state().promptQueue.length === 0);
  assert.equal(state().running, true, 'steering must not end the active turn');
  assert.equal(state().turnId, activeTurn);
  assert.deepEqual(
    state().activeTask,
    activeTask,
    'steer retains original cancellation identity',
  );
  assert.deepEqual(users().slice(-2), ['first follow-up', 'second follow-up']);
  assert.equal(users().filter((text) => text === 'first follow-up').length, 1);
  await until(
    () =>
      database!
        .prepare(
          "SELECT count(*) AS n FROM history WHERE session=? AND json_extract(value,'$.type')='test/steered'",
        )
        .get(session.id)!.n === 2,
  );
  const steered = database!
    .prepare(
      "SELECT value FROM history WHERE session=? AND json_extract(value,'$.type')='test/steered' ORDER BY seq",
    )
    .all(session.id)
    .map((row) => JSON.parse(String(row.value)).data);
  assert.deepEqual(
    steered.map((event) => event.text),
    ['first follow-up', 'second follow-up'],
  );
  assert(steered.every((event) => event.turnId === activeTurn));
  await command('interrupt', { target: state().activeTask }, true);
  await until(() => !state().running);
  await command('enqueue', { text: 'idle enqueue' });
  await until(() => state().promptQueue.length === 0 && !state().running);
  assert(users().includes('idle enqueue'));
  // A definite steering refusal pauses the queue without marking the turn idle.
  await command('prompt', { text: 'hold queue-test-reject' });
  await until(() => !!state().turnId);
  const paused = await command('enqueue', {
    text: 'steer-reject retained message',
  });
  await until(() => state().promptQueue[0]?.state === 'failed');
  assert.equal(state().running, true);
  const rejected = await command(
    'queueRun',
    {
      queueId: paused.result.result.queueId,
      target: { ...state().activeTask, turnId: 'wrong-turn' },
    },
    true,
  );
  assert.equal(rejected.result.error.code, 'TARGET_NOT_FOUND');
  await command(
    'queueRun',
    {
      queueId: paused.result.result.queueId,
      target: state().activeTask,
    },
    true,
  );
  await until(() => state().promptQueue[0]?.state === 'failed');
  const pending = await command('enqueue', {
    text: 'cancel pending follow-up',
  });
  await command(
    'queueCancel',
    { queueId: pending.result.result.queueId },
    true,
  );
  assert.equal(state().promptQueue.length, 1);
  assert(!users().includes('cancel pending follow-up'));
  const tooLarge = await command('enqueue', { text: '\\'.repeat(30000) });
  assert.equal(tooLarge.result.error.code, 'BACKPRESSURE');
  const retainedId = state().promptQueue[0].id;
  // Restart preserves unexecuted content and cannot replay the interrupted session.
  await stopAgent();
  startAgent();
  await until(() => peer);
  const recovered = await snapshot();
  assert.equal(recovered.session.state, 'failed');
  assert.deepEqual(recovered.session.contextUsage, {
    usedTokens: 112000,
    contextWindow: 212000,
  });
  assert.equal(recovered.session.promptQueue[0].id, retainedId);
  assert.equal(
    recovered.session.promptQueue[0].text,
    'steer-reject retained message',
  );
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
  await command('prompt', { text: 'hold current turn' });
  await until(() => !!state().turnId);
  await command('enqueue', { text: 'steer-unknown' });
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
  assert.equal(users().filter((text) => text === 'steer-unknown').length, 1);
  assert(!users().includes('retained behind unknown'));
  console.log(
    'PASS: same-turn FIFO steering, deduplication, cancellation identity, idle start, refusal, stop failure and restart preservation',
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

// Real native Agent, deterministic Codex peer; no model calls or production state.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
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
        instance: frames.filter((frame) => frame.type === 'capabilities').at(-1)
          .deliveryInstance,
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
async function open(
  sessionId: string,
  mode: string,
  stream: string,
  lane = 'normal',
  generation = 1,
) {
  const exchangeId = randomUUID();
  const result = await control('delivery', {
    sessionId,
    mode,
    stream,
    lane,
    exchangeId,
    control: {
      controlEpoch: 1,
      connectionGeneration: generation,
      controlId: 'claim-' + mode,
      owner: 'client',
    },
  });
  assert.equal(result.exchangeId, exchangeId);
  return result;
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
  const allocation = (await open(web.id, 'web', 'web-normal')).window;
  const rawBudget = database
    .prepare('SELECT COUNT(*) AS n FROM transport2_commands')
    .get()!.n;
  for (const payload of [
    { action: 'prompt', requestId: 'raw-prompt', text: 'must not execute' },
    {
      action: 'interrupt',
      requestId: 'raw-interrupt',
      target: {
        controlEpoch: 1,
        instance: 'journal',
        owner: 'client',
        requestId: 'web:original',
        stream: 'normal',
      },
    },
    { action: 'autoApproval', requestId: 'raw-policy', enabled: true },
    {
      action: 'approval',
      requestId: 'raw-approval',
      approvalId: '1',
      runtimeId: 'rt',
      approvalVersion: 'v',
      allow: true,
    },
  ]) {
    send({ type: 'web', sessionId: web.id, epoch: 1, payload });
    await until(() =>
      frames.some(
        (frame) =>
          frame.payload?.requestId === payload.requestId &&
          frame.payload?.error?.code === 'UPGRADE_REQUIRED',
      ),
    );
  }
  assert.equal(
    database.prepare('SELECT COUNT(*) AS n FROM transport2_commands').get()!.n,
    rawBudget,
  );
  assert.equal(
    (await control('snapshot', { sessionId: web.id, mode: 'web' })).session
      .autoApproval,
    false,
  );
  assert.equal(allocation.streamSerial, 1);
  assert.equal(typeof allocation.creditGeneration, 'string');
  assert(allocation.creditGeneration.length > 0);
  const allocationsBefore = database
    .prepare('SELECT COUNT(*) AS count FROM transport2_credit')
    .get()?.count;
  for (const unsafe of [
    { resultReceived: 1 },
    { resultBytes: 1 },
    { seq: 1 },
    { contentSeq: 1, offset: 0 },
  ]) {
    const requestId = randomUUID();
    send({
      type: 'control',
      requestId,
      action: 'delivery',
      data: {
        sessionId: web.id,
        mode: 'web',
        stream: 'unallocated-query',
        lane: 'normal',
        exchangeId: randomUUID(),
        ...unsafe,
      },
    });
    await until(() =>
      frames.some(
        (frame) => frame.type === 'result' && frame.requestId === requestId,
      ),
    );
    assert.equal(
      frames.find((frame) => frame.requestId === requestId).error?.code,
      'INVALID_REQUEST',
    );
  }
  assert.equal(
    database.prepare('SELECT COUNT(*) AS count FROM transport2_credit').get()
      ?.count,
    allocationsBefore,
    'An unbound query or ACK cannot allocate a new receiver stream',
  );
  for (const field of ['instance', 'streamSerial', 'creditGeneration']) {
    const payload = {
      action: 'prompt',
      requestId: 'wrong-allocation-' + field,
      text: 'must not execute',
    };
    const body = JSON.stringify(payload);
    const bad = {
      ...allocation,
      [field]: field === 'streamSerial' ? 999 : 'replaced',
    };
    const before = frames.length;
    send({
      type: 'web',
      sessionId: web.id,
      epoch: 1,
      payload,
      delivery: {
        ...bad,
        stream: 'web-normal',
        lane: 'normal',
        seq: 1,
        end: Buffer.byteLength(body),
        body,
      },
    });
    await until(() =>
      frames
        .slice(before)
        .some(
          (frame) =>
            frame.payload?.type === 'delivery-rejected' &&
            frame.payload.error.code === 'DELIVERY_STATE_MISMATCH',
        ),
    );
    assert.equal(
      (await open(web.id, 'web', 'web-normal')).window.received,
      0,
      'A stale credit proof must not consume the original command slot',
    );
  }
  const repeatedAllocation = (await open(web.id, 'web', 'web-normal')).window;
  assert.equal(repeatedAllocation.streamSerial, allocation.streamSerial);
  assert.equal(
    repeatedAllocation.creditGeneration,
    allocation.creditGeneration,
  );
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
  assert.equal(JSON.parse(result.record.resultBody).requestId, 'exact-task');
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('requests','request_states')",
      )
      .get()?.count,
    0,
    'Reliable commands use their bounded journal, without a duplicate generic receipt',
  );
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
  // Lose the final result ACK, then send no business. The Agent must retry on its own.
  const tailStart = frames.length;
  await until(
    () =>
      frames
        .slice(tailStart)
        .some(
          (frame) =>
            frame.sessionId === web.id &&
            frame.payload?.type === 'delivery-result' &&
            frame.payload?.resultSeq === result.record.resultSeq,
        ),
    45000,
  );
  const instance = (await open(web.id, 'web', 'web-normal')).window.instance;
  send({
    type: 'delivery-receipt',
    sessionId: web.id,
    mode: 'web',
    stream: 'web-normal',
    instance,
    received: result.record.resultSeq,
    receivedBytes: result.record.resultEnd,
  });
  await control('probe');
  assert.equal(
    database
      .prepare('SELECT body FROM transport2_results WHERE stream=? AND seq=?')
      .get('web-normal', result.record.resultSeq)?.body,
    null,
  );
  const resumed = await control('delivery', {
    sessionId: web.id,
    mode: 'web',
    stream: 'web-normal',
    lane: 'normal',
    instance,
    resultReceived: result.record.resultSeq,
    resultBytes: result.record.resultEnd,
  });
  assert.deepEqual(resumed.results, []);
  await assert.rejects(
    control('delivery', {
      sessionId: web.id,
      mode: 'web',
      stream: 'web-normal',
      lane: 'normal',
      instance,
      resultReceived: 0,
      resultBytes: 0,
    }),
    /DELIVERY_STATE_MISMATCH/,
  );
  assert.equal(resumed.window.streamSerial, allocation.streamSerial);
  assert.equal(resumed.window.creditGeneration, allocation.creditGeneration);
  assert.equal(
    database
      .prepare('SELECT body FROM transport2_commands WHERE stream=? AND seq=1')
      .get('web-normal')?.body,
    '',
    'Result ACK compacts the command body while retaining its identity and digest',
  );
  mutation(web.id, 'web-normal', 'normal', 1, 0, prompt);
  await control('probe');
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS count FROM transport2_commands WHERE stream=?',
      )
      .get('web-normal')?.count,
    1,
  );
  const cancellable = await control('create', {
    key: 'create-cancel-web',
    projectId: 'project',
    mode: 'web',
  });
  await control('attach', {
    sessionId: cancellable.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  const cancelWindow = await open(cancellable.id, 'web', 'cancel-normal');
  await open(cancellable.id, 'web', 'cancel-priority', 'priority');
  const target = {
    controlEpoch: 1,
    instance: cancelWindow.window.instance,
    owner: 'client',
    requestId: 'web:never-start',
    stream: 'cancel-normal',
  };
  let priorityEnd = mutation(
    cancellable.id,
    'cancel-priority',
    'priority',
    1,
    0,
    { action: 'interrupt', requestId: 'cancel-first', target },
  );
  await until(
    () =>
      database!
        .prepare(
          'SELECT phase FROM transport2_commands WHERE stream=? AND seq=1',
        )
        .get('cancel-priority')?.phase === 'finished',
  );
  let normalEnd = mutation(cancellable.id, 'cancel-normal', 'normal', 1, 0, {
    action: 'prompt',
    requestId: 'never-start',
    text: 'must never execute',
  });
  await until(
    () =>
      database!
        .prepare(
          'SELECT phase FROM transport2_commands WHERE stream=? AND seq=1',
        )
        .get('cancel-normal')?.phase === 'finished',
  );
  const cancelled = await control('delivery', {
    sessionId: cancellable.id,
    mode: 'web',
    stream: 'cancel-normal',
    lane: 'normal',
    seq: 1,
  });
  assert.equal(
    JSON.parse(cancelled.record.resultBody).error.code,
    'CANCELLED_BEFORE_START',
  );
  const cancelledSnapshot = await control('snapshot', {
    sessionId: cancellable.id,
    mode: 'web',
  });
  assert(
    !cancelledSnapshot.history.events.some(
      (event: any) => event.type === 'user',
    ),
  );
  normalEnd = mutation(
    cancellable.id,
    'cancel-normal',
    'normal',
    2,
    normalEnd,
    {
      action: 'prompt',
      requestId: 'exact-running',
      text: 'hold exact cancellation stale-completion',
    },
  );
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === cancellable.id &&
        frame.payload?.event?.type === 'turn/started',
    ),
  );
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === cancellable.id &&
        frame.payload?.event?.type === 'test/staleCompletionProcessed',
    ),
  );
  assert(
    !frames.some(
      (frame) =>
        frame.sessionId === cancellable.id &&
        frame.payload?.event?.type === 'turn/completed' &&
        frame.payload.event.data?.turn?.id === 'old-turn',
    ),
    'A stale terminal event cannot tell clients the current turn is finished',
  );
  const promisedHistory = database
    .prepare('SELECT bytes,records FROM transport2_history_entries WHERE key=?')
    .get('reservation:' + cancellable.id);
  assert(
    promisedHistory &&
      Number(promisedHistory.bytes) > 0 &&
      Number(promisedHistory.records) > 0,
    'Running turn retains durable byte and record headroom',
  );
  const runningSnapshot = await control('snapshot', {
    sessionId: cancellable.id,
    mode: 'web',
  });
  assert.equal(
    runningSnapshot.session.activeTask.requestId,
    'web:exact-running',
  );
  assert.equal(
    runningSnapshot.session.activeTask.turnId,
    runningSnapshot.session.turnId,
  );
  assert.equal(
    runningSnapshot.session.running,
    true,
    'A stale completed turn cannot expose the active task to idle history cleanup',
  );
  assert(
    !runningSnapshot.history.events.some(
      (event: any) =>
        event.type === 'turn/completed' && event.data?.turn?.id === 'old-turn',
    ),
    'Historical replay cannot reintroduce a rejected stale terminal event',
  );
  const { turnId: _turnId, ...missingTurn } =
    runningSnapshot.session.activeTask;
  let prioritySeq = 2;
  for (const invalidTarget of [
    { ...runningSnapshot.session.activeTask, turnId: 'wrong-turn' },
    missingTurn,
  ]) {
    priorityEnd = mutation(
      cancellable.id,
      'cancel-priority',
      'priority',
      prioritySeq,
      priorityEnd,
      {
        action: 'interrupt',
        requestId: 'wrong-turn-' + prioritySeq,
        target: invalidTarget,
      },
    );
    await until(
      () =>
        database!
          .prepare(
            'SELECT phase FROM transport2_commands WHERE stream=? AND seq=?',
          )
          .get('cancel-priority', prioritySeq)?.phase === 'finished',
    );
    assert.equal(
      (await control('snapshot', { sessionId: cancellable.id, mode: 'web' }))
        .session.running,
      true,
      'A wrong or missing turn identity cannot interrupt the active task',
    );
    prioritySeq++;
  }
  priorityEnd = mutation(
    cancellable.id,
    'cancel-priority',
    'priority',
    prioritySeq,
    priorityEnd,
    {
      action: 'interrupt',
      requestId: 'exact-stop',
      target: runningSnapshot.session.activeTask,
    },
  );
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === cancellable.id &&
        frame.payload?.event?.type === 'turn/completed',
    ),
  );
  assert.equal(
    (await control('snapshot', { sessionId: cancellable.id, mode: 'web' }))
      .session.running,
    false,
  );
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS n FROM transport2_history_entries WHERE key=?',
      )
      .get('reservation:' + cancellable.id)?.n,
    0,
    'Matching completed turn releases unused headroom after durable final output',
  );
  assert(normalEnd > 0);
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
  for (const payload of [
    { id: 90, method: 'initialize', params: {} },
    { id: 91, method: 'thread/start', params: {} },
    { id: 92, method: 'turn/start', params: {} },
    { id: 93, method: 'turn/interrupt', params: {} },
    { id: 94, result: { decision: 'accept' } },
  ]) {
    const before = frames.length;
    send({ type: 'rpc', sessionId: cli.id, epoch: 1, payload });
    await until(() =>
      frames
        .slice(before)
        .some(
          (frame) =>
            frame.sessionId === cli.id &&
            frame.payload?.error?.code === 'UPGRADE_REQUIRED',
        ),
    );
  }
  const foreignBefore = frames.length;
  const foreignState = database
    .prepare('SELECT received FROM transport2_streams WHERE stream=?')
    .get('web-normal')!.received;
  mutation(
    cli.id,
    'web-normal',
    'normal',
    Number(foreignState) + 1,
    0,
    { id: 95, method: 'thread/start', params: {} },
    'cli',
  );
  await until(() =>
    frames
      .slice(foreignBefore)
      .some(
        (frame) =>
          frame.payload?.type === 'delivery-rejected' &&
          frame.payload?.error?.code === 'FORBIDDEN',
      ),
  );
  assert.equal(
    database
      .prepare('SELECT received FROM transport2_streams WHERE stream=?')
      .get('web-normal')!.received,
    foreignState,
  );
  assert.equal(
    database
      .prepare('SELECT COUNT(*) AS n FROM transport2_commands WHERE stream=?')
      .get('cli-normal')!.n,
    0,
  );

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
          .prepare('SELECT sent FROM transport2_output_heads WHERE stream=?')
          .get('rpc-output:' + cli.id)?.sent,
      ) === 1,
  );
  const firstEnd = Number(
    database!
      .prepare(
        'SELECT end_bytes FROM transport2_outputs WHERE stream=? AND seq=1',
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
          .prepare('SELECT sent FROM transport2_output_heads WHERE stream=?')
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
  await open(cli.id, 'cli', 'cli-normal', 'normal', 2);
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
  const cliState = await open(cli.id, 'cli', 'cli-normal', 'normal', 2);
  mutation(
    cli.id,
    'cli-normal',
    'normal',
    2,
    cliState.window.receivedBytes,
    {
      id: 4,
      method: 'initialize',
      params: { clientInfo: { name: 'delivery-large-result', version: '1' } },
    },
    'cli',
    2,
  );
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === cli.id &&
        frame.payload?.type === 'delivery-result' &&
        frame.payload?.seq === 2,
    ),
  );
  const large = frames.find(
    (frame) =>
      frame.sessionId === cli.id &&
      frame.payload?.type === 'delivery-result' &&
      frame.payload?.seq === 2,
  ).payload;
  const descriptor = JSON.parse(large.resultBody);
  assert.equal(descriptor.retention, 'transfer');
  let content = '';
  while (Buffer.byteLength(content) < descriptor.length) {
    const response = await control('delivery', {
      sessionId: cli.id,
      mode: 'cli',
      stream: 'cli-normal',
      lane: 'normal',
      instance: cliState.window.instance,
      contentSeq: large.resultSeq,
      offset: Buffer.byteLength(content),
    });
    assert.equal(response.content.offset, Buffer.byteLength(content));
    content += response.content.body;
    assert.equal(response.content.next, Buffer.byteLength(content));
  }
  assert.equal(
    createHash('sha256').update(content).digest('hex'),
    descriptor.digest,
  );
  assert.equal(JSON.parse(content).result.userAgent, '你好'.repeat(50000));
  send({
    type: 'delivery-receipt',
    sessionId: cli.id,
    mode: 'cli',
    stream: 'cli-normal',
    instance: cliState.window.instance,
    received: large.resultSeq,
    receivedBytes: large.resultEnd,
  });
  await control('probe');
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS count FROM transport2_result_content WHERE stream=?',
      )
      .get('cli-normal')?.count,
    0,
  );
  await open(cli.id, 'cli', 'cli-priority', 'priority', 2);
  mutation(
    cli.id,
    'cli-priority',
    'priority',
    1,
    0,
    {
      method: 'coc/cancel',
      params: {
        target: {
          stream: 'cli-normal',
          instance: cliState.window.instance,
          controlEpoch: 1,
          owner: 'client',
          requestId: 'rpc:999',
        },
      },
    },
    'cli',
    2,
  );
  await until(
    () =>
      database!
        .prepare(
          'SELECT phase FROM transport2_commands WHERE stream=? AND seq=1',
        )
        .get('cli-priority')?.phase === 'finished',
  );
  const afterLarge = await open(cli.id, 'cli', 'cli-normal', 'normal', 2);
  mutation(
    cli.id,
    'cli-normal',
    'normal',
    3,
    afterLarge.window.receivedBytes,
    {
      id: 999,
      method: 'turn/start',
      params: {},
    },
    'cli',
    2,
  );
  await until(
    () =>
      database!
        .prepare(
          'SELECT phase FROM transport2_commands WHERE stream=? AND seq=3',
        )
        .get('cli-normal')?.phase === 'finished',
  );
  const cancelledCli = await control('delivery', {
    sessionId: cli.id,
    mode: 'cli',
    stream: 'cli-normal',
    lane: 'normal',
    seq: 3,
  });
  assert.equal(
    JSON.parse(cancelledCli.record.resultBody).error.data.code,
    'CANCELLED_BEFORE_START',
  );
  const cliHistory = await control('snapshot', {
    sessionId: cli.id,
    mode: 'cli',
  });
  assert(
    !cliHistory.history.events.some((event: any) => event.type === 'user'),
  );
  await control('stop', { sessionId: cli.id });
  await until(() => {
    const row = database!
      .prepare('SELECT value FROM sessions WHERE id=?')
      .get(cli.id);
    return row && JSON.parse(String(row.value)).state === 'closed';
  });
  const closed = await open(cli.id, 'cli', 'cli-normal', 'normal', 2);
  assert.equal(closed.window.closed, true);
  assert.equal(
    (
      await control('delivery', {
        sessionId: cli.id,
        mode: 'cli',
        stream: 'cli-normal',
        lane: 'normal',
        seq: 3,
      })
    ).record.resultBody,
    cancelledCli.record.resultBody,
    'Session exit retires admission while preserving its unacknowledged original result',
  );
  // Actual CLI admission: stalled read RPCs fill normal pending slots, while
  // a proof-bound interruption uses its independent reservation. Client IDs
  // include numeric 0 and string "0" and collide with internal request numbers.
  const bounded = await control('create', {
    projectId: 'project',
    mode: 'cli',
  });
  await control('attach', {
    sessionId: bounded.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  await open(bounded.id, 'cli', 'bounded-normal');
  await open(bounded.id, 'cli', 'bounded-priority', 'priority');
  send({
    type: 'delivery-output',
    sessionId: bounded.id,
    epoch: 1,
    received: 0,
    credit: 100,
    byteCredit: 1024 * 1024,
    replay: true,
  });
  let boundedEnd = 0;
  for (const [index, payload] of [
    { id: 1001, method: 'initialize', params: {} },
    { id: 1002, method: 'thread/start', params: {} },
    {
      id: 1003,
      method: 'turn/start',
      params: {
        input: [{ type: 'text', text: 'hold runtime budget' }],
      },
    },
  ].entries()) {
    boundedEnd = mutation(
      bounded.id,
      'bounded-normal',
      'normal',
      index + 1,
      boundedEnd,
      payload,
      'cli',
    );
    await until(
      () =>
        database!
          .prepare(
            'SELECT phase FROM transport2_commands WHERE stream=? AND seq=?',
          )
          .get('bounded-normal', index + 1)?.phase === 'finished',
    );
  }
  await until(() => {
    const state = database!
      .prepare('SELECT value FROM sessions WHERE id=?')
      .get(bounded.id);
    return state && JSON.parse(String(state.value)).activeTask?.turnId;
  });
  const boundedSession = await control('get', { sessionId: bounded.id });
  const boundedOutput = () =>
    frames
      .filter(
        (frame) =>
          frame.sessionId === bounded.id &&
          frame.payload?.type === 'delivery-data',
      )
      .map((frame) => JSON.parse(frame.payload.body));
  const heldIds = [0, '0', ...Array.from({ length: 62 }, (_, i) => i + 1)];
  for (const id of heldIds)
    send({
      type: 'rpc',
      sessionId: bounded.id,
      epoch: 1,
      payload: {
        id,
        method: 'model/list',
        params: { cursor: 'runtime-budget-hold', marker: JSON.stringify(id) },
      },
    });
  send({
    type: 'rpc',
    sessionId: bounded.id,
    epoch: 1,
    payload: { id: 'overflow', method: 'model/list', params: {} },
  });
  await until(() =>
    boundedOutput().some(
      (item) =>
        item.id === 'overflow' && item.error?.data?.code === 'BACKPRESSURE',
    ),
  );
  assert(
    !boundedOutput().some((item) => item.result?.original),
    'Held requests must remain pending',
  );
  // Interruption must not create another user event.
  const userCount = Number(
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM history WHERE session=? AND json_extract(value,'$.type')='user'",
      )
      .get(bounded.id)!.n,
  );
  mutation(
    bounded.id,
    'bounded-priority',
    'priority',
    1,
    0,
    {
      id: 7777,
      method: 'turn/interrupt',
      params: {
        threadId: boundedSession.threadId,
        turnId: boundedSession.turnId,
      },
      coc: { target: boundedSession.activeTask },
    },
    'cli',
  );
  await until(
    () =>
      boundedOutput().filter((item) => item.result?.original).length ===
      heldIds.length,
  );
  await until(
    () =>
      database!
        .prepare(
          'SELECT phase FROM transport2_commands WHERE stream=? AND seq=1',
        )
        .get('bounded-priority')?.phase === 'finished',
  );
  const boundedResults = boundedOutput().filter(
    (item) => item.result?.original,
  );
  for (const id of heldIds)
    assert.equal(
      boundedResults.filter(
        (item) => item.id === id && item.result.original === JSON.stringify(id),
      ).length,
      1,
      'The original client ID must survive collision with internal interruption IDs',
    );
  send({
    type: 'rpc',
    sessionId: bounded.id,
    epoch: 1,
    payload: { id: 'after-drain', method: 'model/list', params: {} },
  });
  await until(() =>
    boundedOutput().some(
      (item) => item.id === 'after-drain' && item.result?.data,
    ),
  );
  assert.equal(
    Number(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM history WHERE session=? AND json_extract(value,'$.type')='user'",
        )
        .get(bounded.id)!.n,
    ),
    userCount,
  );
  // Once the old task has stopped, filling reads again must reject a new turn
  // before the user event / running flag is written or Codex sees its input.
  for (const id of heldIds)
    send({
      type: 'rpc',
      sessionId: bounded.id,
      epoch: 1,
      payload: {
        id,
        method: 'model/list',
        params: { cursor: 'runtime-budget-hold', marker: JSON.stringify(id) },
      },
    });
  mutation(
    bounded.id,
    'bounded-normal',
    'normal',
    4,
    boundedEnd,
    {
      id: 'rejected-turn',
      method: 'turn/start',
      params: {
        threadId: boundedSession.threadId,
        input: [{ type: 'text', text: 'must never start under pressure' }],
      },
    },
    'cli',
  );
  await until(
    () =>
      database!
        .prepare(
          'SELECT phase FROM transport2_commands WHERE stream=? AND seq=4',
        )
        .get('bounded-normal')?.phase === 'finished',
  );
  const refusedTurn = JSON.parse(
    String(
      database
        .prepare(
          'SELECT body FROM transport2_results WHERE stream=? AND command_seq=4',
        )
        .get('bounded-normal')!.body,
    ),
  );
  assert.equal(refusedTurn.error?.data?.code, 'BACKPRESSURE');
  assert.equal(
    (await control('get', { sessionId: bounded.id })).running,
    false,
  );
  assert.equal(
    Number(
      database
        .prepare(
          "SELECT COUNT(*) AS n FROM history WHERE session=? AND json_extract(value,'$.type')='user'",
        )
        .get(bounded.id)!.n,
    ),
    userCount,
  );
  await control('stop', { sessionId: bounded.id });
  const slow = await control('create', {
    key: 'slow-output-client',
    projectId: 'project',
    mode: 'cli',
  });
  await control('attach', {
    sessionId: slow.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  await open(slow.id, 'cli', 'slow-normal');
  send({
    type: 'delivery-output',
    sessionId: slow.id,
    epoch: 1,
    received: 0,
    credit: 0,
    byteCredit: 0,
    replay: true,
  });
  mutation(
    slow.id,
    'slow-normal',
    'normal',
    1,
    0,
    {
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'delivery-output-flood', version: '1' } },
    },
    'cli',
  );
  await until(() => {
    const row = database!
      .prepare('SELECT value FROM sessions WHERE id=?')
      .get(slow.id);
    return row && JSON.parse(String(row.value)).state === 'failed';
  });
  const exhausted = await control('snapshot', {
    sessionId: slow.id,
    mode: 'cli',
  });
  assert.equal(exhausted.session.outputError.code, 'BACKPRESSURE');
  const usage = database
    .prepare(
      'SELECT bytes,records FROM transport2_output_budget WHERE stream=?',
    )
    .get('rpc-output:' + slow.id)!;
  assert(Number(usage.bytes) <= 8 * 1024 * 1024 && Number(usage.records) > 0);
  assert(
    database
      .prepare('SELECT body FROM transport2_outputs WHERE stream=? AND seq=1')
      .get('rpc-output:' + slow.id),
    'A slow receiver cannot evict earlier unacknowledged output',
  );
  assert.equal((await open(slow.id, 'cli', 'slow-normal')).window.closed, true);
  // Closed sessions still have authoritative history, independent of a live runtime.
  const subscription = {
    operation: 'subscribe',
    sessionId: cli.id,
    owner: 'history-reader',
    stream: 'history-stream',
    instance: 'history-storage',
    exchangeId: randomUUID(),
    route: 'history-route',
    receivedRevision: 0,
    acknowledgedRevision: 0,
  };
  const historyWindow = await control('history', subscription);
  const notices = () =>
    frames.filter(
      (frame) =>
        frame.type === 'history-notice' && frame.route === subscription.route,
    );
  await until(() => notices().length >= 3, 6000);
  assert(
    notices().every(
      (frame) => frame.payload.maxRevision === historyWindow.maxRevision,
    ),
    'Losing the last event and dirty hints recovers without another business message',
  );
  const historyPage = await control('history', {
    sessionId: cli.id,
    operation: 'page',
    after: 0,
  });
  assert.equal(historyPage.snapshotSeq, historyWindow.maxRevision);
  const historyAck = {
    ...subscription,
    operation: 'ack',
    receivedRevision: historyPage.snapshotSeq,
    agentInstance: historyWindow.agentInstance,
    streamSerial: historyWindow.streamSerial,
    creditGeneration: historyWindow.creditGeneration,
  };
  const confirmed = await control('history', historyAck);
  assert.equal(confirmed.receivedRevision, historyPage.snapshotSeq);
  assert.equal(
    (await control('history', historyAck)).receivedRevision,
    confirmed.receivedRevision,
    'A lost history ACK response can retry the same endpoint identity',
  );
  const count = notices().length;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    notices().length,
    count,
    'A fully acknowledged history subscriber emits no retry traffic',
  );
  send({ type: 'history-detached', route: subscription.route });
  const historyResumed = await control('history', {
    ...historyAck,
    operation: 'subscribe',
    route: 'resumed-history-route',
    exchangeId: randomUUID(),
    acknowledgedRevision: confirmed.receivedRevision,
  });
  assert.equal(historyResumed.streamSerial, historyWindow.streamSerial);
  assert.equal(historyResumed.receivedRevision, confirmed.receivedRevision);
  const abandoned = {
    ...subscription,
    stream: 'abandoned-reader',
    route: 'abandoned-history-route',
  };
  await control('history', abandoned);
  const abandonedCount = () =>
    frames.filter(
      (frame) =>
        frame.type === 'history-notice' && frame.route === abandoned.route,
    ).length;
  await until(() => abandonedCount() > 0);
  const beforeDetach = abandonedCount();
  send({ type: 'history-detached', route: abandoned.route });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(
    abandonedCount(),
    beforeDetach,
    'Disconnected readers pause retries without deleting durable history',
  );
  const beforeUnbound = {
    commands: database
      .prepare('SELECT COUNT(*) AS n FROM transport2_commands')
      .get()!.n,
    cancels: database
      .prepare('SELECT COUNT(*) AS n FROM transport2_cancel')
      .get()!.n,
    stream: database
      .prepare(
        'SELECT received, received_bytes FROM transport2_streams WHERE stream=?',
      )
      .get('cancel-priority'),
  };
  const beforeMalformedCapabilities = frames.filter(
    (frame) => frame.type === 'capabilities',
  ).length;
  mutation(cancellable.id, 'cancel-priority', 'priority', 5, priorityEnd, {
    action: 'interrupt',
    requestId: 'missing-target',
  });
  await until(() =>
    log.includes('Interruption requires the original task identity'),
  );
  assert.deepEqual(
    {
      commands: database
        .prepare('SELECT COUNT(*) AS n FROM transport2_commands')
        .get()!.n,
      cancels: database
        .prepare('SELECT COUNT(*) AS n FROM transport2_cancel')
        .get()!.n,
      stream: database
        .prepare(
          'SELECT received, received_bytes FROM transport2_streams WHERE stream=?',
        )
        .get('cancel-priority'),
    },
    beforeUnbound,
    'A malformed interruption cannot consume sequence, persist a command or create a cancellation marker',
  );
  await until(
    () =>
      peer &&
      frames.filter((frame) => frame.type === 'capabilities').length >
        beforeMalformedCapabilities,
  );
  const external = await control('create', {
    key: 'create-external-reservations',
    projectId: 'project',
    mode: 'web',
    external: true,
    threadId: 'external-history',
  });
  const queueRecords = () => {
    const state = JSON.parse(
      readFileSync(join(projectRoot, '.fake-external.json'), 'utf8'),
    );
    assert.equal(
      state.queueAdds,
      state.queue.length,
      'Source deduplication must not hide duplicate queue/add dispatches',
    );
    return state.queue;
  };
  const queuePromises = () =>
    database!
      .prepare(
        "SELECT key,bytes,records FROM transport2_history_entries WHERE session=? AND key GLOB 'reservation:*' ORDER BY key",
      )
      .all(external.id);
  const queued = await control('queue', {
    sessionId: external.id,
    mode: 'web',
    requestId: 'external-queue-original',
    text: 'first external receipt',
  });
  assert.equal(queued.state, 'queued');
  assert.equal(
    queuePromises().length,
    0,
    'Accepted receipt retires only its queue promise',
  );
  assert.deepEqual(
    await control('queue', {
      sessionId: external.id,
      mode: 'web',
      requestId: 'external-queue-original',
      text: 'first external receipt',
    }),
    queued,
  );
  assert.equal(
    queueRecords().length,
    1,
    'Original queue retry cannot submit again',
  );
  await control('attach', {
    sessionId: external.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  await open(external.id, 'web', 'external-queue-web');
  mutation(external.id, 'external-queue-web', 'normal', 1, 0, {
    action: 'prompt',
    requestId: 'external-web-original',
    text: 'web external receipt',
  });
  await until(
    () =>
      database!
        .prepare(
          'SELECT phase FROM transport2_commands WHERE stream=? AND seq=1',
        )
        .get('external-queue-web')?.phase === 'finished',
  );
  assert.equal(queueRecords().length, 2);
  assert.equal(
    queuePromises().length,
    0,
    'Web queue uses the same isolated promise lifecycle',
  );
  const recoveredData = {
    sessionId: external.id,
    mode: 'web',
    requestId: 'external-recovered-original',
    text: 'lost queue reply',
  };
  const recoveredIntent = {
    requestId: recoveredData.requestId,
    owner: 'a'.repeat(64),
    instance: frames.filter((frame) => frame.type === 'capabilities').at(-1)
      .deliveryInstance,
  };
  const recoveredRequest = randomUUID();
  send({
    type: 'control',
    requestId: recoveredRequest,
    action: 'queue',
    data: recoveredData,
    intent: recoveredIntent,
  });
  await until(
    () =>
      frames.some(
        (frame) =>
          frame.type === 'result' && frame.requestId === recoveredRequest,
      ),
    25000,
  );
  const recoveredReply = frames.find(
    (frame) => frame.type === 'result' && frame.requestId === recoveredRequest,
  );
  assert(!recoveredReply.error, JSON.stringify(recoveredReply.error));
  assert.equal(
    recoveredReply.data.state,
    'queued',
    'Lost reply is recovered by a read-only positive queue lookup',
  );
  const operationKey = createHash('sha256')
    .update(JSON.stringify([recoveredIntent.owner, recoveredIntent.requestId]))
    .digest('hex');
  const expectedClientId =
    'coc-' +
    createHash('sha256')
      .update(
        JSON.stringify([
          'queue-v1',
          recoveredIntent.instance,
          external.id,
          'operation:' + operationKey,
        ]),
      )
      .digest('hex');
  assert.equal(
    recoveredReply.data.clientUserMessageId,
    expectedClientId,
    'Correlation derives from durable original scope without a mapping table',
  );
  assert.equal(
    queuePromises().length,
    0,
    'Verified acceptance consumes only its original promise',
  );
  assert.deepEqual(
    await control('queue', recoveredData),
    recoveredReply.data,
    'Original retry returns the recovered durable receipt',
  );
  assert.equal(
    JSON.parse(readFileSync(join(projectRoot, '.fake-external.json'), 'utf8'))
      .queueAdds,
    3,
    'Reply recovery and original retry never dispatch queue/add twice',
  );
  const lostIntent = {
    requestId: 'external-lost-original',
    owner: 'a'.repeat(64),
    instance: frames.filter((frame) => frame.type === 'capabilities').at(-1)
      .deliveryInstance,
  };
  const lostData = {
    sessionId: external.id,
    mode: 'web',
    requestId: lostIntent.requestId,
    text: 'lost consumed queue reply',
  };
  const lostRequest = randomUUID();
  send({
    type: 'control',
    requestId: lostRequest,
    action: 'queue',
    data: lostData,
    intent: lostIntent,
  });
  await until(() => queuePromises().length === 1);
  const pendingPromise = queuePromises();
  await until(
    () =>
      frames.some(
        (frame) => frame.type === 'result' && frame.requestId === lostRequest,
      ),
    25000,
  );
  assert.equal(
    frames.find(
      (frame) => frame.type === 'result' && frame.requestId === lostRequest,
    ).error.code,
    'RESULT_UNKNOWN',
  );
  assert.deepEqual(
    queuePromises(),
    pendingPromise,
    'Unknown external submission retains its full isolated promise',
  );
  const retryLost = randomUUID();
  send({
    type: 'control',
    requestId: retryLost,
    action: 'queue',
    data: lostData,
    intent: lostIntent,
  });
  await until(() =>
    frames.some(
      (frame) => frame.type === 'result' && frame.requestId === retryLost,
    ),
  );
  assert.equal(
    queueRecords().length,
    4,
    'Unknown result retry cannot create a new external submission',
  );
  const queueUsage = database
    .prepare('SELECT bytes FROM transport2_history_budget WHERE scope=?')
    .get(external.id)!;
  const fillKey = 'reservation:' + JSON.stringify([external.id, 'test-full']);
  database
    .prepare(
      'INSERT INTO transport2_history_entries(key,session,bytes,records) VALUES(?,?,?,1)',
    )
    .run(fillKey, external.id, 64 * 1024 * 1024 - Number(queueUsage.bytes));
  await assert.rejects(
    control('queue', {
      sessionId: external.id,
      mode: 'web',
      requestId: 'external-capacity-refusal',
      text: 'must not reach queue',
    }),
    /BACKPRESSURE/,
  );
  const sourceFile = join(projectRoot, '.fake-external.json');
  const sourceState = JSON.parse(readFileSync(sourceFile, 'utf8'));
  const observedItem = () =>
    database!
      .prepare(
        'SELECT seq,fingerprint FROM external_items WHERE session=? AND item=?',
      )
      .get(external.id, 'external-10');
  const originalItem = observedItem();
  assert(originalItem, 'The item is already part of the observed live turn');
  const originalHistoryUsage = database
    .prepare(
      'SELECT bytes,records FROM transport2_history_budget WHERE scope=?',
    )
    .get(external.id);
  sourceState.items[10].text = 'recovered external output '.repeat(1000);
  sourceState.items.push({
    id: 'external-after-capacity',
    type: 'agentMessage',
    text: 'new tail',
  });
  writeFileSync(sourceFile, JSON.stringify(sourceState));
  const syncPending = () =>
    JSON.parse(
      String(
        database!
          .prepare('SELECT value FROM sessions WHERE id=?')
          .get(external.id)!.value,
      ),
    ).historySyncPending;
  await until(() => syncPending() === true);
  assert.deepEqual(
    observedItem(),
    originalItem,
    'Quota rollback preserves the original item fingerprint',
  );
  assert.deepEqual(
    database
      .prepare(
        'SELECT bytes,records FROM transport2_history_budget WHERE scope=?',
      )
      .get(external.id),
    originalHistoryUsage,
    'Refused observation cannot partially consume history capacity',
  );
  assert.equal(
    (await control('get', { sessionId: external.id })).state,
    'ready',
  );
  assert.equal(
    child.exitCode,
    null,
    'External import backpressure leaves Agent and source writer alone',
  );
  const archiveBefore = database
    .prepare('SELECT MIN(seq) AS seq FROM history WHERE session=?')
    .get(external.id)!.seq;
  const archiveQuery = {
    sessionId: external.id,
    mode: 'web',
    before: archiveBefore,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      control('history', archiveQuery),
      /Authoritative history budget exhausted/,
    );
  }
  assert.equal(
    (await control('get', { sessionId: external.id })).state,
    'ready',
    'Archive quota error returns to caller without closing its reader',
  );
  database
    .prepare('DELETE FROM transport2_history_entries WHERE key=?')
    .run(fillKey);
  const archiveRecovered = await control('history', archiveQuery);
  assert(
    archiveRecovered.events.length > 0,
    'Archive load marker and cursor recover after quota refusal',
  );
  await until(
    () =>
      !syncPending() &&
      observedItem()?.fingerprint !== originalItem.fingerprint,
    25000,
  );
  assert.equal(
    observedItem()!.seq,
    originalItem.seq,
    'Recovered output keeps its original native item projection',
  );
  assert.equal(
    database
      .prepare('SELECT bytes FROM bodies WHERE seq=?')
      .get(originalItem.seq)!.bytes,
    Buffer.byteLength(sourceState.items[10].text),
  );
  assert(
    database
      .prepare('SELECT seq FROM external_items WHERE session=? AND item=?')
      .get(external.id, 'external-after-capacity'),
    'Reader retries the original cursor and also imports the new tail',
  );
  assert.deepEqual(
    JSON.parse(readFileSync(sourceFile, 'utf8')),
    sourceState,
    'Read-only recovery does not change the original writer or queue',
  );
  assert.equal(
    queueRecords().length,
    4,
    'History admission rejects before the external queue side effect',
  );
  assert.deepEqual(
    queuePromises(),
    pendingPromise,
    'A separate refusal cannot refund the unknown submission',
  );
  assert.equal(
    (await control('get', { sessionId: external.id })).state,
    'ready',
    'Safe queue refusal keeps the Agent available',
  );
  const windowSession = await control('create', {
    key: 'create-output-window',
    projectId: 'window',
    mode: 'web',
  });
  await control('attach', {
    sessionId: windowSession.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  await open(windowSession.id, 'web', 'window-normal');
  mutation(windowSession.id, 'window-normal', 'normal', 1, 0, {
    action: 'prompt',
    requestId: 'window-task',
    text: 'hold output window',
  });
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === windowSession.id &&
        frame.payload?.event?.type === 'turn/started',
    ),
  );
  const windowUsage = database
    .prepare('SELECT bytes FROM transport2_history_budget WHERE scope=?')
    .get(windowSession.id)!;
  const windowFill =
    'reservation:' + JSON.stringify([windowSession.id, 'test-output-full']);
  database
    .prepare(
      'INSERT INTO transport2_history_entries(key,session,bytes,records) VALUES(?,?,?,1)',
    )
    .run(
      windowFill,
      windowSession.id,
      64 * 1024 * 1024 - Number(windowUsage.bytes),
    );
  send({
    type: 'web',
    sessionId: windowSession.id,
    epoch: 1,
    payload: {
      action: 'models',
      requestId: 'window-output-trigger',
      cursor: 'history-window-overflow',
    },
  });
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === windowSession.id &&
        frame.payload?.event?.type === 'sessionClosed',
    ),
  );
  const stoppedWindow = await control('snapshot', {
    sessionId: windowSession.id,
    mode: 'web',
  });
  assert.equal(stoppedWindow.session.state, 'failed');
  assert.equal(stoppedWindow.session.historyError.code, 'BACKPRESSURE');
  assert.equal(stoppedWindow.session.historyError.incomplete, true);
  const admittedOutput = stoppedWindow.history.events.find(
    (event: any) => event.type === 'item/agentMessage/delta',
  );
  assert.equal(
    admittedOutput.data.delta,
    'saved-prefix'.repeat(8),
    'Every admitted buffered delta survives output-window refusal',
  );
  assert(
    stoppedWindow.history.events.some(
      (event: any) =>
        event.type === 'sessionClosed' && event.data.error?.incomplete,
    ),
    'Protected terminal history explicitly records the incomplete output',
  );
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS n FROM transport2_history_entries WHERE key=?',
      )
      .get('control-reservation:' + windowSession.id)?.n,
    0,
    'Runtime exit converts its protected terminal capacity exactly once',
  );
  assert(
    Number(
      database
        .prepare('SELECT bytes FROM transport2_history_entries WHERE key=?')
        .get('reservation:' + windowSession.id)?.bytes,
    ) > 0,
    'Unknown task output responsibility retains its remaining ordinary promise',
  );
  database
    .prepare('DELETE FROM transport2_history_entries WHERE key=?')
    .run(windowFill);
  assert.equal(
    (await control('get', { sessionId: external.id })).state,
    'ready',
    'History capacity stops only the affected runtime',
  );
  assert.equal(
    child.exitCode,
    null,
    'History capacity refusal does not terminate the Agent',
  );
  await control('attach', {
    sessionId: external.id,
    epoch: 1,
    expires: Date.now() + 60000,
  });
  const webUnknownStream = 'external-queue-web-unknown';
  await open(external.id, 'web', webUnknownStream);
  mutation(external.id, webUnknownStream, 'normal', 1, 0, {
    action: 'prompt',
    requestId: 'external-web-unknown',
    text: 'lost consumed queue reply',
  });
  await until(
    () =>
      database!
        .prepare(
          'SELECT phase FROM transport2_commands WHERE stream=? AND seq=1',
        )
        .get(webUnknownStream)?.phase === 'finished',
    25000,
  );
  const webUnknownResult = database
    .prepare(
      'SELECT seq,end_bytes FROM transport2_results WHERE stream=? AND command_seq=1',
    )
    .get(webUnknownStream)!;
  send({
    type: 'delivery-receipt',
    sessionId: external.id,
    mode: 'web',
    stream: webUnknownStream,
    received: webUnknownResult.seq,
    receivedBytes: webUnknownResult.end_bytes,
  });
  await until(
    () =>
      database!
        .prepare(
          'SELECT result FROM transport2_commands WHERE stream=? AND seq=1',
        )
        .get(webUnknownStream)?.result === null,
  );
  assert.notEqual(
    database
      .prepare('SELECT body FROM transport2_commands WHERE stream=? AND seq=1')
      .get(webUnknownStream)!.body,
    '',
    'ACK retains unresolved web input evidence',
  );
  const pendingPromisesBeforeRestart = queuePromises();
  assert.equal(pendingPromisesBeforeRestart.length, 2);
  const stoppedAgent = child;
  const exitedAgent = new Promise((resolve) =>
    stoppedAgent.once('close', resolve),
  );
  assert(
    database
      .prepare('SELECT key FROM transport2_history_entries WHERE key=?')
      .get('control-reservation:' + external.id),
    'Live observer still owns its terminal slot',
  );
  stoppedAgent.kill('SIGKILL');
  await exitedAgent;
  await until(() => !peer);
  child = spawn(
    resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent'),
    ['run', '--config', config],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout!.on('data', (data) => (log += data));
  child.stderr!.on('data', (data) => (log += data));
  await until(() => peer);
  assert.deepEqual(
    queuePromises(),
    pendingPromisesBeforeRestart,
    'Agent restart retains unknown queue capacity',
  );
  assert.equal(
    database
      .prepare(
        'SELECT COUNT(*) AS n FROM transport2_history_entries WHERE key=?',
      )
      .get('control-reservation:' + external.id)!.n,
    0,
    'Crash recovery consumes the old runtime terminal slot',
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM history WHERE session=? AND json_extract(value,'$.type')='sessionClosed'",
      )
      .get(external.id)!.n,
    1,
    'Crash recovery materializes one observer runtime closure',
  );
  assert.equal(
    (await control('get', { sessionId: external.id })).state,
    'failed',
  );
  const afterRestart = randomUUID();
  send({
    type: 'control',
    requestId: afterRestart,
    action: 'queue',
    data: lostData,
    intent: lostIntent,
  });
  await until(() =>
    frames.some(
      (frame) => frame.type === 'result' && frame.requestId === afterRestart,
    ),
  );
  assert.equal(
    frames.find(
      (frame) => frame.type === 'result' && frame.requestId === afterRestart,
    ).error.code,
    'RESULT_UNKNOWN',
  );
  assert.equal(
    queueRecords().length,
    5,
    'Restarted original-result query cannot execute the queue again',
  );
  const returnedQueue = JSON.parse(readFileSync(sourceFile, 'utf8'));
  returnedQueue.revealUnknownQueue = true;
  writeFileSync(sourceFile, JSON.stringify(returnedQueue));
  await until(() => queuePromises().length === 0, 100000);
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM history WHERE session=? AND json_extract(value,'$.type')='queueAccepted' AND json_extract(value,'$.data.requestId')=?",
      )
      .get(external.id, lostData.requestId)!.n,
    1,
    'Background read-only reconciliation records the original accepted fact',
  );
  await assert.rejects(control('queue', lostData), /RESULT_UNKNOWN/);
  assert.equal(
    queueRecords().length,
    5,
    'Positive recovery never repeats queue/add',
  );
  assert.equal(
    JSON.parse(readFileSync(sourceFile, 'utf8')).queueAdds,
    5,
    'Original submission count is unchanged after background recovery',
  );
  assert.equal(
    database
      .prepare('SELECT body FROM transport2_commands WHERE stream=? AND seq=1')
      .get(webUnknownStream)!.body,
    '',
    'Resolved acknowledged web evidence is atomically cleared',
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS n FROM history WHERE session=? AND json_extract(value,'$.type')='queueAccepted' AND json_extract(value,'$.data.requestId')='external-web-unknown'",
      )
      .get(external.id)!.n,
    1,
    'Web recovery publishes exactly one original accepted fact',
  );
  const recoveredWindow = await control('snapshot', {
    sessionId: windowSession.id,
    mode: 'web',
  });
  assert.equal(recoveredWindow.session.historyError.incomplete, true);
  assert.deepEqual(
    recoveredWindow.history.events,
    stoppedWindow.history.events,
    'Restart preserves the admitted output and explicit incomplete-history evidence',
  );
  console.log(
    'PASS: native durable command/result recovery, exact cancellation, verified transfer, stable reservations, output credit, bounded slow-receiver termination, closed-flow result recovery, end-to-end history tail recovery isolated external queue promises and bounded history output windows',
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

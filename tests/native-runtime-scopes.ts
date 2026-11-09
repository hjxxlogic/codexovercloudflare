// Internal business component executable; public encrypted transport has separate integration coverage.
// Actual native Agent and stdio/WebSocket peers; isolated local state, no models.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { operationWrite } from '../packages/protocol/src/index.ts';
import { WebSocketServer, type WebSocket } from 'ws';
import { SharedApprovals } from './fixtures/shared-approvals.ts';
const root = mkdtempSync(join(tmpdir(), 'coc-runtime-scopes-'));
const projects = Array.from({ length: 6 }, (_, n) => {
  const path = join(root, 'p' + n);
  mkdirSync(path);
  return { id: 'p' + n, name: 'Project ' + n, path };
});
const shared = new SharedApprovals(projects[0].path);
const originalEndpoint = await shared.ready();
const frames: any[] = [];
let peer: WebSocket | undefined;
let child: ChildProcess | undefined;
let log = '';
const windows = new Map<string, any>();
const ends = new Map<string, number>();
const sequences = new Map<string, number>();
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
    assert(
      Buffer.byteLength(String(raw)) <= 256 * 1024,
      'Agent exceeded the actual wire frame bound',
    );
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    if (frame.type === 'capabilities') peer = ws;
    const window = frame.data?.window ?? frame.payload?.window;
    if (window) windows.set(window.stream, window);
  });
  ws.on('close', () => {
    if (peer === ws) peer = undefined;
  });
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const config = join(root, 'agent.json');
writeFileSync(
  config,
  JSON.stringify({
    relayUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    hostId: 'scopes',
    token: 'runtime-budget-local-token',
    dataDir: join(root, 'state'),
    autoUpdate: false,
    projects,
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    externalSessions: {
      allowApprovals: true,
      approvalEndpoint: originalEndpoint,
    },
  }),
  { mode: 0o600 },
);
async function until(test: () => unknown | Promise<unknown>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await test())) {
    assert(Date.now() < deadline, 'Timed out: ' + log.slice(-2000));
    await new Promise((done) => setTimeout(done, 20));
  }
}
function send(frame: any) {
  assert(peer);
  peer.send(JSON.stringify(frame));
}
async function control(action: string, data: any = {}) {
  const requestId = randomUUID();
  const instance = operationWrite(action, data)
    ? (await control('probe')).operationInstance
    : undefined;
  send({
    type: 'control',
    action,
    data,
    requestId,
    ...(operationWrite(action, data)
      ? {
          intent: {
            owner: 'a'.repeat(64),
            requestId: data.requestId || requestId,
            instance,
          },
        }
      : {}),
  });
  await until(() =>
    frames.some(
      (frame) => frame.type === 'result' && frame.requestId === requestId,
    ),
  );
  const result = frames.find(
    (frame) => frame.type === 'result' && frame.requestId === requestId,
  );
  if (result.error)
    throw Object.assign(new Error(result.error.message), result.error);
  return result.data;
}
async function open(session: any, stream: string, lane = 'normal') {
  const result = await control('delivery', {
    sessionId: session.id,
    mode: 'web',
    stream,
    lane,
    exchangeId: randomUUID(),
    control: {
      controlEpoch: 1,
      controlId: 'scope-control',
      owner: 'client',
      connectionGeneration: 1,
    },
  });
  windows.set(stream, result.window);
  return result.window;
}
function streamId(session: any, lane = 'normal') {
  return lane + '-' + session.id.split('~').at(-1);
}
async function session(project = 0, extra: any = {}) {
  const created = await control('create', {
    projectId: projects[project].id,
    mode: 'web',
    ...extra,
  });
  await control('attach', {
    sessionId: created.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  await open(created, streamId(created, 'priority'), 'priority');
  return created;
}
function command(session: any, stream: string, payload: any, lane = 'normal') {
  const window = windows.get(stream);
  assert(window);
  const body = JSON.stringify(payload);
  const seq = (sequences.get(stream) || 0) + 1;
  const end = (ends.get(stream) || 0) + Buffer.byteLength(body);
  sequences.set(stream, seq);
  ends.set(stream, end);
  send({
    type: 'web',
    sessionId: session.id,
    epoch: 1,
    payload,
    delivery: {
      stream,
      lane,
      seq,
      end,
      body,
      instance: window.instance,
      streamSerial: window.streamSerial,
      creditGeneration: window.creditGeneration,
    },
  });
}
const results = (stream: string) =>
  frames
    .filter(
      (frame) =>
        frame.payload?.type === 'delivery-result' &&
        frame.payload.stream === stream,
    )
    .map((frame) => ({
      frame: frame.payload,
      result: JSON.parse(frame.payload.resultBody),
    }));
function read(session: any, cursor: string) {
  const requestId = randomUUID();
  send({
    type: 'web',
    sessionId: session.id,
    epoch: 1,
    payload: { action: 'models', requestId, cursor },
  });
  return requestId;
}
async function readDone(session: any, cursor: string) {
  const requestId = read(session, cursor);
  await until(() =>
    frames.some(
      (frame) =>
        frame.sessionId === session.id &&
        frame.payload?.requestId === requestId,
    ),
  );
}
async function usage() {
  return (await control('probe')).runtimeResources;
}
async function sampleResources(phase: string) {
  const status = readFileSync(`/proc/${child!.pid}/status`, 'utf8');
  const quantity = (key: string) =>
    Number(status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1] ?? 0) *
    1024;
  const directory = join(root, 'state');
  let stateFileBytes = 0;
  for (const name of readdirSync(directory)) {
    const file = statSync(join(directory, name));
    if (file.isFile()) stateFileBytes += file.size;
  }
  console.log(
    'RESOURCE_SAMPLE ' +
      JSON.stringify({
        phase,
        agentRssBytes: quantity('VmRSS'),
        agentPeakRssBytes: quantity('VmHWM'),
        stateFileBytes,
        resources: await usage(),
      }),
  );
}
async function stopped(sessions: any[]) {
  for (const item of sessions) await control('stop', { sessionId: item.id });
  await until(async () => {
    const state = await usage();
    return (
      state.commands.records === 0 &&
      state.priority.records === 0 &&
      state.approvals.records === 0
    );
  });
}
async function history(session: any) {
  return (await control('snapshot', { sessionId: session.id, mode: 'web' }))
    .history.events;
}
try {
  child = spawn(
    resolve('build/coc-agent-component'),
    ['run', '--config', config],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  child.stdout!.on('data', (value) => {
    log += value;
  });
  child.stderr!.on('data', (value) => {
    log += value;
  });
  await until(() => peer);
  // Keep two turns active in the same directory and verify stopping one is isolated.
  const parallel = [await session(), await session()];
  for (const [index, item] of parallel.entries()) {
    const stream = streamId(item);
    await open(item, stream);
    command(item, stream, {
      action: 'prompt',
      requestId: 'parallel-' + index,
      text: 'parallel hold ' + index,
    });
    await until(() =>
      results(stream).some(
        (entry) => entry.result.requestId === 'parallel-' + index,
      ),
    );
    assert.equal(results(stream).at(-1)!.result.type, 'ack');
  }
  for (const item of parallel)
    assert.equal(
      (await control('snapshot', { sessionId: item.id, mode: 'web' })).session
        .running,
      true,
    );
  await control('stop', { sessionId: parallel[0].id });
  assert.equal(
    (await control('snapshot', { sessionId: parallel[1].id, mode: 'web' }))
      .session.running,
    true,
  );
  await stopped([parallel[1]]);
  console.log('PASS: same project concurrent turns and isolated session stop');
  // Fill local queues, then the actual shared 512-record limit using six runtimes.
  const queues = [];
  for (let n = 0; n < 6; n++) queues.push(await session(n));
  const rejected: string[] = [];
  for (const item of queues)
    for (let n = 0; n < 101; n++)
      rejected.push(read(item, 'scope-budget-stall'));
  await until(async () => (await usage()).commands.records === 512);
  assert(
    frames.some(
      (frame) =>
        rejected.includes(frame.payload?.requestId) &&
        frame.payload?.error?.code === 'BACKPRESSURE',
    ),
  );
  const priority = streamId(queues[5], 'priority');
  command(
    queues[5],
    priority,
    { action: 'autoApproval', requestId: 'priority-at-full', enabled: false },
    'priority',
  );
  await until(() =>
    results(priority).some(
      (item) => item.result.requestId === 'priority-at-full',
    ),
  );
  assert.equal(
    results(priority).find(
      (item) => item.result.requestId === 'priority-at-full',
    )!.result.type,
    'ack',
  );
  assert.equal(
    (await usage()).commands.records,
    512,
    'Priority may not borrow or release normal records',
  );
  await sampleResources('512 queued reads');
  await stopped(queues);
  console.log(
    'PASS: actual Web queue local/global record pressure, independent priority and release on close',
  );
  const referenceSession = await session();
  const referenceStream = streamId(referenceSession);
  await open(referenceSession, referenceStream);
  const originalText = 'immutable user text 你好 ' + 'x'.repeat(9000);
  command(referenceSession, referenceStream, {
    action: 'prompt',
    requestId: 'history-reference',
    text: originalText,
  });
  await until(() =>
    results(referenceStream).some(
      (item) => item.result.requestId === 'history-reference',
    ),
  );
  const referenceResult = results(referenceStream).find(
    (item) => item.result.requestId === 'history-reference',
  )!;
  const reference = referenceResult.result.result.history;
  assert.equal(reference.retention, 'history');
  assert.equal(reference.length, Buffer.byteLength(originalText));
  assert.equal(
    reference.digest,
    createHash('sha256').update(originalText).digest('hex'),
  );
  const receiptWindow = windows.get(referenceStream);
  send({
    type: 'delivery-receipt',
    sessionId: referenceSession.id,
    mode: 'web',
    stream: referenceStream,
    instance: receiptWindow.instance,
    streamSerial: receiptWindow.streamSerial,
    creditGeneration: receiptWindow.creditGeneration,
    received: referenceResult.frame.resultSeq,
    receivedBytes: referenceResult.frame.resultEnd,
  });
  await until(async () => (await usage()).resultRoutes.records === 0);
  let offset = 0,
    originalContent = '';
  do {
    const part = await control('history', {
      sessionId: referenceSession.id,
      operation: 'content',
      seq: reference.seq,
      revision: reference.revision,
      reference,
      offset,
    });
    originalContent += part.text;
    offset = part.more ? part.nextOffset : -1;
  } while (offset >= 0);
  assert.equal(
    originalContent,
    originalText,
    'Result ACK must not delete authoritative history',
  );
  await assert.rejects(
    control('history', {
      sessionId: referenceSession.id,
      operation: 'content',
      seq: reference.seq,
      reference: { ...reference, revision: reference.revision + 1 },
    }),
    (error: any) => error.code === 'CONTENT_UNAVAILABLE',
  );
  await assert.rejects(
    control('history', {
      sessionId: referenceSession.id,
      operation: 'content',
      seq: reference.seq,
      reference: { ...reference, sessionId: 'another~session' },
    }),
    (error: any) => error.code === 'FORBIDDEN',
  );
  await stopped([referenceSession]);
  console.log(
    'PASS: actual immutable history descriptor, result ACK retains original content, route cache reclamation and unavailable revision',
  );
  // Byte pressure is reached with only three large queued prompts. Cancellation
  // reclaims the exact queued original immediately, despite a stalled read ahead.
  const bytes = await session();
  const normal = streamId(bytes);
  await open(bytes, normal);
  read(bytes, 'scope-budget-stall');
  for (let n = 1; n <= 4; n++)
    command(bytes, normal, {
      action: 'prompt',
      requestId: 'byte-' + n,
      text: 'x'.repeat(64000),
    });
  await until(() =>
    results(normal).some((item) => item.result.requestId === 'byte-4'),
  );
  assert.equal(
    results(normal).find((item) => item.result.requestId === 'byte-4')!.result
      .error.code,
    'BACKPRESSURE',
  );
  const beforeCancel = await usage();
  await sampleResources('Web byte pressure');
  assert.equal(beforeCancel.commands.records, 4);
  assert(beforeCancel.commands.bytes <= 2 * 1024 * 1024);
  command(
    bytes,
    streamId(bytes, 'priority'),
    {
      action: 'interrupt',
      requestId: 'cancel-queued',
      target: {
        controlEpoch: 1,
        instance: windows.get(normal).instance,
        owner: 'client',
        requestId: 'web:byte-1',
        stream: normal,
      },
    },
    'priority',
  );
  await until(() =>
    results(normal).some((item) => item.result.requestId === 'byte-1'),
  );
  assert.equal(
    results(normal).find((item) => item.result.requestId === 'byte-1')!.result
      .error.code,
    'CANCELLED_BEFORE_START',
  );
  await until(async () => (await usage()).commands.records === 3);
  command(bytes, normal, {
    action: 'prompt',
    requestId: 'byte-5',
    text: 'x'.repeat(64000),
  });
  await until(async () => (await usage()).commands.records === 4);
  assert.equal(
    (await history(bytes)).filter((event: any) => event.type === 'user').length,
    0,
  );
  await stopped([bytes]);
  console.log(
    'PASS: actual Web byte refusal, durable terminal result and exact cancellation releases its queue reservation',
  );
  // The normal approval set retains typed identities and stable versions on replay.
  const approvals: any[] = [];
  for (let n = 0; n < 5; n++) approvals.push(await session(n));
  for (let n = 0; n < approvals.length; n++) {
    const stream = streamId(approvals[n]);
    await open(approvals[n], stream);
    command(approvals[n], stream, {
      action: 'prompt',
      requestId: 'approvals-' + n,
      text: 'scope-approvals:' + (n < 4 ? 33 : 1),
    });
    if (n < 4)
      await until(
        async () => (await usage()).approvals.records === (n + 1) * 32,
      );
  }
  await until(async () =>
    (await history(approvals[4])).some(
      (event: any) =>
        event.type === 'scope/decision' &&
        event.data.error?.data?.code === 'BACKPRESSURE',
    ),
  );
  assert.equal((await usage()).approvals.records, 128);
  await sampleResources('128 pending approvals');
  const pending = await control('approvals', {
    sessionId: approvals[0].id,
    mode: 'web',
  });
  assert.equal(pending.data.length, 32);
  const first = pending.data[0];
  const issued = (await history(approvals[0])).filter(
    (event: any) => event.type === 'approval',
  );
  assert.equal(
    issued.length,
    32,
    'Exact replay must not mint another version or event',
  );
  assert.equal(
    issued.find((event: any) => event.data.approvalId === first.approvalId).data
      .approvalVersion,
    first.approvalVersion,
  );
  command(
    approvals[0],
    streamId(approvals[0], 'priority'),
    {
      action: 'approval',
      requestId: 'explicit-deny',
      approvalId: first.approvalId,
      runtimeId: first.runtimeId,
      approvalVersion: first.approvalVersion,
      allow: false,
    },
    'priority',
  );
  await until(async () => (await usage()).approvals.records === 127);
  await readDone(approvals[4], 'scope-budget-one');
  await until(async () => (await usage()).approvals.records === 128);
  await readDone(approvals[4], 'scope-budget-large');
  assert.equal(
    (await usage()).approvals.records,
    128,
    'Oversized approval must not replace an existing reservation',
  );
  // A dense history snapshot still carries every pending approval within one frame.
  await readDone(approvals[1], 'scope-budget-history');
  const start = frames.length;
  send({
    type: 'web',
    sessionId: approvals[1].id,
    epoch: 1,
    payload: { action: 'sync', after: 0 },
  });
  await until(() =>
    frames.slice(start).some((frame) => frame.payload?.type === 'sync'),
  );
  const sync = frames
    .slice(start)
    .find((frame) => frame.payload?.type === 'sync').payload;
  assert.equal(sync.approvals.length, 32);
  assert(Buffer.byteLength(JSON.stringify(sync.events)) > 64 * 1024);
  // Ambiguous reuse closes the original runtime and invalidates its old proofs.
  read(approvals[0], 'scope-budget-conflict');
  await until(
    async () =>
      (await control('get', { sessionId: approvals[0].id })).state === 'failed',
  );
  assert.equal((await usage()).approvals.records, 97);
  await stopped(approvals.slice(1));
  console.log(
    'PASS: actual approval count/global quotas, replay versions, explicit denial, oversized input, dense sync and conflicting ID shutdown',
  );
  // An original external server keeps authority when its forwarding cache fills.
  for (let n = 0; n < 33; n++) shared.add('external-history');
  const external = await session(0, {
    external: true,
    threadId: 'external-history',
  });
  await until(async () =>
    (await history(external)).some(
      (event: any) =>
        event.type === 'warning' &&
        event.data.message.includes('budget exhausted'),
    ),
  );
  assert.equal(
    shared.decisions.size,
    0,
    'Overflow must not automatically approve or deny on the original server',
  );
  assert.equal(shared.pending.size, 33);
  const unavailable = await control('approvals', {
    sessionId: external.id,
    mode: 'web',
  });
  assert.equal(unavailable.forwarding, false);
  assert.equal(unavailable.data.length, 0);
  assert.equal(
    (await usage()).approvals.records,
    0,
    'Disconnect must release both forwarding and Agent mirrors',
  );
  await stopped([external]);
  console.log(
    'PASS: external approval overflow disconnects, frees mirrors and preserves all original pending decisions',
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise<void>((done) => child!.once('exit', () => done())),
      new Promise((done) => setTimeout(done, 5000)),
    ]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((done) => sockets.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
  await shared.close();
  rmSync(root, { recursive: true, force: true });
}

// Actual isolated Agent, Codex protocol fixture and Linux bubblewrap PTY; no model calls.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { operationWrite } from '../packages/protocol/src/index.ts';
const root = mkdtempSync(join(tmpdir(), 'coc-terminal-agent-'));
const project = join(root, 'project');
mkdirSync(project);
let peer: WebSocket | undefined, child: ChildProcess | undefined;
let log = '';
const frames: any[] = [];
const server = createServer((_req, res) =>
  res
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end('{"pending":[]}'),
);
const sockets = new WebSocketServer({ server });
sockets.on('connection', (ws) => {
  peer = ws;
  ws.send(
    JSON.stringify({
      type: 'hello',
      minProtocol: 1,
      delivery: 2,
      demand: 1,
      epoch: 1,
    }),
  );
  ws.on('message', (data) => frames.push(JSON.parse(String(data))));
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const config = join(root, 'agent.json');
writeFileSync(
  config,
  JSON.stringify({
    relayUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    hostId: 'terminal',
    token: 'local-terminal-test-token',
    dataDir: join(root, 'state'),
    autoUpdate: false,
    projects: [{ id: 'project', name: 'Terminal test', path: project }],
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    sandbox: 'workspace-write',
    terminal: { enabled: true },
  }),
  { mode: 0o600 },
);
async function until(test: () => unknown | Promise<unknown>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!(await test())) {
    assert(
      Date.now() < deadline,
      'Native terminal timed out\n' + log.slice(-2000),
    );
    await new Promise((done) => setTimeout(done, 20));
  }
}
function send(frame: object) {
  assert(peer);
  peer.send(JSON.stringify(frame));
}
async function control(action: string, data: any = {}, id = randomUUID()) {
  const requestId = randomUUID();
  send({
    type: 'control',
    action,
    data,
    requestId,
    ...(operationWrite(action, data)
      ? {
          intent: {
            owner: 'a'.repeat(64),
            requestId: id,
            instance: (await control('probe')).operationInstance,
          },
        }
      : {}),
  });
  await until(() =>
    frames.some((f) => f.type === 'result' && f.requestId === requestId),
  );
  const result = frames.find(
    (f) => f.type === 'result' && f.requestId === requestId,
  );
  if (result.error)
    throw Object.assign(new Error(result.error.message), result.error);
  return result.data;
}
try {
  child = spawn(resolve('build/coc-agent'), ['run', '--config', config], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (data) => {
    log += data;
  });
  child.stderr!.on('data', (data) => {
    log += data;
  });
  await until(() => frames.some((f) => f.type === 'capabilities'));
  const info = await control('terminal', {
    operation: 'info',
    projectId: 'project',
  });
  assert.equal(info.enabled, true);
  const session = await control('create', {
    projectId: 'project',
    mode: 'web',
  });
  const account = 'terminal-mailbox';
  assert.deepEqual(
    (await control('list', { paged: true, cwAccountId: account })).data,
    [],
    'A session without an email is absent from the mailbox directory',
  );
  await control('attach', {
    cwAccountId: account,
    sessionId: session.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
  assert.deepEqual(
    (await control('list', { paged: true, cwAccountId: account })).data.map(
      (s: any) => s.id,
    ),
    [session.id],
    'Connecting explicitly associates the existing session with the current mailbox',
  );
  assert.deepEqual(
    (await control('list', { paged: true, cwAccountId: 'other-mailbox' })).data,
    [],
  );
  const proof = {
    controlEpoch: 1,
    controlId: 'terminal-controller',
    owner: 'a'.repeat(64),
    connectionGeneration: 1,
  };
  const stream = 'terminal-test-normal';
  const window = (
    await control('delivery', {
      sessionId: session.id,
      mode: 'web',
      stream,
      lane: 'normal',
      exchangeId: randomUUID(),
      control: proof,
    })
  ).window;
  const base = {
    projectId: 'project',
    sessionId: session.id,
    owner: 'a'.repeat(64),
    control: proof,
  };
  const id = randomUUID(),
    body = { ...base, operation: 'open' };
  const opened = await control('terminal', body, id);
  assert.deepEqual(
    await control('terminal', body, id),
    opened,
    'open retries reuse original PTY',
  );
  const scoped = { ...base, terminalId: opened.terminalId };
  for (const operation of ['read', 'input', 'resize'])
    await assert.rejects(
      control('terminal', { ...scoped, operation }),
      (error: any) => error.code === 'UPGRADE_REQUIRED',
    );
  await assert.rejects(
    control('terminal', {
      ...scoped,
      operation: 'read',
      owner: 'b'.repeat(64),
    }),
    (error: any) => error.code === 'STALE_CONTROLLER',
  );
  const payload = {
    action: 'prompt',
    requestId: randomUUID(),
    text: 'must be refused while terminal lives',
  };
  const encoded = JSON.stringify(payload);
  send({
    type: 'web',
    sessionId: session.id,
    epoch: 1,
    payload,
    delivery: {
      stream,
      lane: 'normal',
      seq: 1,
      end: Buffer.byteLength(encoded),
      body: encoded,
      instance: window.instance,
      streamSerial: window.streamSerial,
      creditGeneration: window.creditGeneration,
    },
  });
  await until(() =>
    frames.some(
      (f) =>
        f.payload?.type === 'delivery-result' && f.payload.stream === stream,
    ),
  );
  assert.equal(
    JSON.parse(
      frames.find(
        (f) =>
          f.payload?.type === 'delivery-result' && f.payload.stream === stream,
      ).payload.resultBody,
    ).error.code,
    'PROJECT_BUSY',
  );
  const rejected = frames.find(
    (f) => f.payload?.type === 'delivery-result' && f.payload.stream === stream,
  ).payload;
  send({
    type: 'delivery-receipt',
    sessionId: session.id,
    mode: 'web',
    stream,
    instance: window.instance,
    streamSerial: window.streamSerial,
    creditGeneration: window.creditGeneration,
    received: rejected.resultSeq,
    receivedBytes: rejected.resultEnd,
  });
  assert.equal(info.streaming, 2);
  let offset = 0;
  let route = randomUUID();
  const streaming = (frame: object) =>
    send({
      type: 'terminal-stream',
      route,
      scope: { ...scoped, operation: 'stream' },
      frame,
    });
  const streamFrames = () =>
    frames
      .filter((f) => f.type === 'terminal-stream' && f.route === route)
      .map((f) => f.frame);
  streaming({ type: 'bind', offset });
  await until(() =>
    streamFrames().some((f) => f.type === 'ready' && f.next === 1),
  );
  const initial = {
    type: 'input',
    seq: 1,
    data: Buffer.from("printf 'AGENT_%s\\n' TERMINAL_OK\n").toString('base64'),
  };
  streaming(initial);
  streaming(initial);
  await until(() =>
    streamFrames()
      .filter((f) => f.type === 'output')
      .map((f) => Buffer.from(f.data, 'base64').toString())
      .join('')
      .includes('AGENT_TERMINAL_OK\r\n'),
  );
  offset = streamFrames()
    .filter((f) => f.type === 'output')
    .at(-1).offset;
  streaming({ type: 'ack', offset });
  if (process.env.COC_TEST_TERMINAL_IDLE === '1') {
    // Only native protocol Ping/Pong may run during this interval.
    await new Promise((done) => setTimeout(done, 500));
    const before = frames.length;
    await new Promise((done) => setTimeout(done, 35000));
    await new Promise((done) => setTimeout(done, 30000));
    assert.equal(
      frames.length,
      before,
      'Idle bound PTY generates no application frames: ' +
        JSON.stringify(frames.slice(before)),
    );
  }
  const streamInput = {
    type: 'input',
    seq: 2,
    data: Buffer.from("printf 'STREAM_%s\\n' OK\n").toString('base64'),
  };
  streaming(streamInput);
  streaming(streamInput);
  const streamText = () =>
    streamFrames()
      .filter((f) => f.type === 'output')
      .map((f) => Buffer.from(f.data, 'base64').toString())
      .join('');
  await until(() => streamText().includes('STREAM_OK\r\n'));
  assert.equal(
    streamText().split('STREAM_OK\r\n').length,
    2,
    'duplicate stream input executes once',
  );
  assert(streamFrames().some((f) => f.type === 'ack' && f.next === 3));
  offset = streamFrames()
    .filter((f) => f.type === 'output')
    .at(-1).offset;
  streaming({ type: 'ack', offset });
  const before = streamFrames().filter((f) => f.type === 'output').length;
  streaming({
    type: 'input',
    seq: 3,
    data: Buffer.from("printf '%100000s' X\n").toString('base64'),
  });
  const burst = () =>
    streamFrames()
      .filter((f) => f.type === 'output')
      .slice(before);
  const bytes = () =>
    burst().reduce((n, f) => n + Buffer.from(f.data, 'base64').length, 0);
  await until(() => bytes() === 65536);
  await new Promise((done) => setTimeout(done, 200));
  assert.equal(
    bytes(),
    65536,
    'PTY output stops at the unacknowledged byte window',
  );
  offset = burst().at(-1).offset;
  streaming({ type: 'ack', offset });
  await until(() => bytes() > 100000);
  offset = burst().at(-1).offset;
  streaming({ type: 'ack', offset });
  const bulkStart = streamFrames().filter((f) => f.type === 'output').length;
  streaming({
    type: 'input',
    seq: 4,
    data: Buffer.from(
      "printf '%1000000s\\n' X; printf 'BULK_DONE\\n'\n",
    ).toString('base64'),
  });
  let consumed = bulkStart,
    bulk = '';
  await until(() => {
    const pending = streamFrames()
      .filter((f) => f.type === 'output')
      .slice(consumed);
    for (const frame of pending) {
      assert.equal(
        frame.gap,
        false,
        'a live slow stream applies PTY backpressure rather than truncating',
      );
      bulk += Buffer.from(frame.data, 'base64').toString();
      offset = frame.offset;
      consumed++;
      streaming({ type: 'ack', offset });
    }
    return bulk.includes('BULK_DONE\r\n');
  });
  assert(
    bulk.length > 1000000,
    'output larger than the ring buffer is delivered completely',
  );
  streaming({ type: 'resize', seq: 5, cols: 100, rows: 30 });
  await until(() =>
    streamFrames().some((f) => f.type === 'ack' && f.next === 6),
  );
  streaming({ type: 'ack', offset: Number.MAX_SAFE_INTEGER });
  await until(() =>
    streamFrames().some(
      (f) => f.type === 'error' && f.error.code === 'INVALID_REQUEST',
    ),
  );
  route = randomUUID();
  streaming({ type: 'bind', offset });
  await until(() =>
    streamFrames().some((f) => f.type === 'ready' && f.next === 6),
  );
  streaming({ type: 'ack', offset: 0.5 });
  await until(() =>
    streamFrames().some(
      (f) => f.type === 'error' && f.error.code === 'INVALID_REQUEST',
    ),
  );
  route = randomUUID();
  streaming({ type: 'bind', offset });
  await until(() =>
    streamFrames().some((f) => f.type === 'ready' && f.next === 6),
  );
  send({ type: 'terminal-stream', route, detached: true });
  streaming({
    type: 'input',
    seq: 6,
    data: Buffer.from('must not execute\n').toString('base64'),
  });
  await until(() =>
    streamFrames().some(
      (f) => f.type === 'error' && f.error.code === 'STREAM_CLOSED',
    ),
  );
  await control('terminal', { ...scoped, operation: 'close' });
  await new Promise((done) => setTimeout(done, 300));
  const detached = await control('terminal', { ...base, operation: 'open' });
  send({ type: 'detach', sessionId: session.id, epoch: 1 });
  await assert.rejects(
    control('terminal', {
      ...base,
      terminalId: detached.terminalId,
      operation: 'read',
    }),
    (error: any) => error.code === 'STALE_CONTROLLER',
  );
  await control('attach', {
    sessionId: session.id,
    epoch: 2,
    expires: Date.now() + 15000,
  });
  await assert.rejects(
    control('terminal', {
      ...base,
      terminalId: detached.terminalId,
      operation: 'input',
      seq: 1,
      data: Buffer.from('echo STALE\n').toString('base64'),
    }),
    (error: any) => error.code === 'STALE_CONTROLLER',
  );
  await control('stop', { sessionId: session.id });
  console.log(
    'Native Agent terminal: original open, controller fencing, assistant exclusion, PTY output, streaming credit/acks, reconnect, input deduplication and close passed',
  );
} finally {
  child?.kill('SIGTERM');
  if (child && child.exitCode === null)
    await new Promise<void>((done) => child!.once('exit', () => done()));
  for (const ws of sockets.clients) ws.terminate();
  sockets.close();
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
}

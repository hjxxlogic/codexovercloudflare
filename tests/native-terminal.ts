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
            instance: frames.find((f) => f.type === 'capabilities')
              .deliveryInstance,
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
  await control('attach', {
    sessionId: session.id,
    epoch: 1,
    expires: Date.now() + 15000,
  });
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
  const input = {
    ...scoped,
    operation: 'input',
    seq: 1,
    data: Buffer.from("printf 'AGENT_%s\\n' TERMINAL_OK\n").toString('base64'),
  };
  await control('terminal', input);
  await control('terminal', input);
  let output = '',
    offset = 0;
  await until(async () => {
    const result = await control('terminal', {
      ...scoped,
      operation: 'read',
      offset,
    });
    offset = result.offset;
    output += Buffer.from(result.data, 'base64').toString();
    return output.includes('AGENT_TERMINAL_OK\r\n');
  });
  assert.equal(output.split('AGENT_TERMINAL_OK\r\n').length, 2);
  assert.equal(info.streaming, 1);
  let route = randomUUID();
  const streaming = (frame: object) =>
    send({
      type: 'terminal-stream',
      route,
      scope: { ...scoped, operation: 'read' },
      frame,
    });
  const streamFrames = () =>
    frames
      .filter((f) => f.type === 'terminal-stream' && f.route === route)
      .map((f) => f.frame);
  streaming({ type: 'bind', offset });
  await until(() =>
    streamFrames().some((f) => f.type === 'ready' && f.next === 2),
  );
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
  await until(
    async () =>
      (await control('terminal', { ...scoped, operation: 'read', offset }))
        .exited,
  );
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

// Real native sockets and elapsed time; no model or production requests.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
const dir = mkdtempSync(join(tmpdir(), 'coc-demand-'));
let approvals = 0,
  connections = 0,
  frames = 0,
  pings = 0;
let peer: WebSocket | undefined;
let replyToPing = true;
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/api/v1/agent/requests') {
    approvals++;
    res.end(JSON.stringify({ hostId: 'host', pending: [] }));
  } else res.writeHead(404).end('{}');
});
const sockets = new WebSocketServer({ server, autoPong: false });
sockets.on('connection', (ws) => {
  peer = ws;
  connections++;
  if (connections > 1) replyToPing = true;
  ws.send(JSON.stringify({ type: 'hello', minProtocol: 1, demand: 1 }));
  ws.on('message', () => frames++);
  ws.on('ping', (payload) => {
    assert.equal(payload.toString(), 'coc-keepalive');
    pings++;
    if (replyToPing) ws.pong(payload);
  });
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const relayUrl = `http://127.0.0.1:${(server.address() as any).port}`;
const file = join(dir, 'agent.json');
writeFileSync(
  file,
  JSON.stringify({
    relayUrl,
    hostId: 'host',
    token: 'local-test-agent-demand-credential',
    autoUpdate: false,
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    dataDir: join(dir, 'state'),
    projects: [{ id: 'test', name: 'test', path: dir }],
    sandbox: 'read-only',
  }),
  { mode: 0o600 },
);
const agent = spawn(
  resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent'),
  ['run', '--config', file],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '';
agent.stderr.on('data', (value) => {
  output += value;
});
agent.stdout.on('data', (value) => {
  output += value;
});
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function wait(test: () => boolean, label: string, timeout = 10000) {
  const until = Date.now() + timeout;
  while (!test()) {
    if (Date.now() >= until) throw new Error(label + '\n' + output);
    await delay(30);
  }
}
try {
  await wait(() => frames === 1 && approvals === 1, 'initial synchronization');
  const idle = { frames, approvals, connections, pings };
  await delay(Number(process.env.COC_IDLE_MS || 95000));
  assert.deepEqual(
    { frames, approvals, connections },
    {
      frames: idle.frames,
      approvals: idle.approvals,
      connections: idle.connections,
    },
    output,
  );
  assert.ok(
    pings >= Math.floor(Number(process.env.COC_IDLE_MS || 95000) / 30000),
  );
  assert.equal(agent.exitCode, null);
  peer!.send(
    JSON.stringify({ type: 'change', scope: 'requests', revision: 1 }),
  );
  await wait(() => approvals === 2, 'event-driven approval read');
  let confirmed = false;
  peer!.on('message', (raw) => {
    const d = JSON.parse(raw.toString());
    if (d.requestId === 'probe') confirmed = d.data?.online === true;
  });
  peer!.send(
    JSON.stringify({
      type: 'control',
      requestId: 'probe',
      action: 'probe',
      data: {},
    }),
  );
  await wait(() => confirmed, 'on-demand round trip');
  const healthyPings = pings;
  replyToPing = false;
  const lostAt = Date.now();
  // Data frames must not substitute for protocol Pong or mask a broken heartbeat.
  const traffic = setInterval(() => {
    if (peer?.readyState === 1) peer.send(JSON.stringify({ type: 'pong' }));
  }, 1000);
  try {
    await wait(
      () => connections === 2 && approvals === 3,
      'Pong timeout reconnect',
      100000,
    );
  } finally {
    clearInterval(traffic);
  }
  assert.ok(
    Date.now() - lostAt >= 55000,
    'must not close before Pong deadline',
  );
  assert.match(output, /WebSocket Pong timeout after 90 seconds/);
  assert.equal(agent.exitCode, null);
  assert.ok(pings > healthyPings);
  console.log(
    JSON.stringify({
      scenario: 'A-only',
      elapsedIdleMs: Number(process.env.COC_IDLE_MS || 95000),
      periodicFrames: 0,
      periodicApprovalReads: 0,
      protocolPings: healthyPings,
      idleReconnects: 0,
      missingPongReconnect: 'passed',
      missingPongRecoveryMs: Date.now() - lostAt,
      approvalEvent: 'passed',
      probe: 'passed',
    }),
  );
} finally {
  await new Promise<void>((done) => {
    if (agent.exitCode !== null) done();
    else {
      agent.once('exit', () => done());
      agent.kill('SIGTERM');
    }
  });
  for (const ws of sockets.clients) ws.terminate();
  await new Promise<void>((done) =>
    sockets.close(() => server.close(() => done())),
  );
  rmSync(dir, { recursive: true, force: true });
}

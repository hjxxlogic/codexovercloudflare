// Real Agent processes and wall-clock timers; no model or production requests.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
const dir = mkdtempSync(join(tmpdir(), 'coc-retry-'));
const children: { child: ChildProcess; output: string }[] = [];
const attempts: number[] = [];
const connected = new Map<string, number>();
const server = createServer((_req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ hostId: 'host', pending: [] }));
});
const sockets = new WebSocketServer({ noServer: true });
let recovered: WebSocket | undefined;
server.on('upgrade', (req, socket, head) => {
  const token = req.headers.authorization?.replace('Bearer ', '') ?? '';
  const attempt =
    token === 'local-test-retry-network-credential' ? attempts.length : -1;
  if (attempt >= 0) attempts.push(performance.now());
  if (attempt === 0 || attempt === 1) {
    socket.end(
      `HTTP/1.1 ${attempt === 0 ? '401 Unauthorized' : '403 Forbidden'}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
    );
    return;
  }
  sockets.handleUpgrade(req, socket, head, (ws) => {
    ws.on('message', (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type !== 'channel-register') return;
      ws.send(JSON.stringify({ type: 'channel-registered' }));
      connected.set(token, (connected.get(token) ?? 0) + 1);
      if (attempt === 3) ws.close(4001, 'Synthetic authorization rejection');
      else if (token === 'local-test-retry-network-credential') recovered = ws;
    });
    ws.send(
      JSON.stringify({
        type: attempt === 2 ? 'hello' : 'channel-welcome',
        version: 1,
      }),
    );
  });
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const relayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
function settings(token: string, state = token) {
  return {
    relayUrl,
    hostId: 'host',
    token,
    autoUpdate: false,
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    dataDir: join(dir, state),
    projects: [{ id: 'test', name: 'test', path: dir }],
    sandbox: 'read-only',
  };
}
function save(file: string, config: unknown) {
  writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
}
function launch(file: string) {
  const entry = {
    child: spawn(
      resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent'),
      ['run', '--config', file],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, COC_NO_STARTUP_REPAIR: '1' },
      },
    ),
    output: '',
  };
  entry.child.stdout!.on('data', (data) => {
    entry.output += data;
  });
  entry.child.stderr!.on('data', (data) => {
    entry.output += data;
  });
  children.push(entry);
  return entry;
}
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function wait(test: () => boolean, label: string, timeout = 40000) {
  const deadline = Date.now() + timeout;
  while (!test()) {
    assert(
      Date.now() < deadline,
      label + '\n' + children.map((x) => x.output).join('\n'),
    );
    await delay(30);
  }
}
async function stop(
  entry: (typeof children)[number],
  signal: NodeJS.Signals = 'SIGTERM',
) {
  assert.equal(entry.child.exitCode, null, entry.output);
  entry.child.kill(signal);
  await wait(
    () => entry.child.exitCode !== null || entry.child.signalCode !== null,
    'explicit stop',
    10000,
  );
  assert.equal(entry.child.exitCode, 0, entry.output);
}
async function connectionFailures() {
  const file = join(dir, 'network.json');
  save(file, settings('local-test-retry-network-credential'));
  const entry = launch(file);
  await wait(
    () => recovered !== undefined,
    '401 / 403 / incompatible hello / 4001 recovery',
    140000,
  );
  assert.equal(attempts.length, 5);
  for (let i = 1; i < attempts.length; ++i)
    assert(
      attempts[i] - attempts[i - 1] >= 30000,
      'every failed attempt waits at least 30 seconds',
    );
  assert.match(entry.output, /HTTP 401/);
  assert.match(entry.output, /HTTP 403/);
  assert.match(entry.output, /Encrypted endpoint channel required/);
  assert.match(
    entry.output,
    /Relay disconnected \(code 4001\); retrying in 30 seconds/,
  );
  assert.equal(entry.child.exitCode, null, entry.output);
  recovered!.close(1012, 'Stop while reconnect is pending');
  await wait(
    () => entry.output.includes('Relay disconnected (code 1012)'),
    'retry pending',
  );
  await stop(entry);
  await delay(31000);
  assert.equal(attempts.length, 5, 'explicit exit cancels future connections');
  console.log(
    JSON.stringify({
      scenario: 'connection-failures',
      attemptIntervalsMs: attempts
        .slice(1)
        .map((at, i) => Math.round(at - attempts[i])),
      authorizationRejectionRetries: true,
      incompatibleRelayRetries: true,
      stopCancelsRetry: true,
    }),
  );
}
async function initializationFailures() {
  const file = join(dir, 'initialization.json');
  writeFileSync(file, '{invalid json', { mode: 0o600 });
  const failedAt = performance.now();
  const entry = launch(file);
  await wait(
    () => entry.output.includes('Agent initialization or runtime failed'),
    'invalid config keeps running',
  );
  assert.equal(entry.child.exitCode, null);
  const config = settings(
    'local-test-retry-startup-credential',
    'shared-state',
  );
  save(file, { ...config, codexPath: join(dir, 'missing-codex') });
  await wait(
    () =>
      (entry.output.match(/Agent initialization or runtime failed/g) ?? [])
        .length >= 2,
    'Codex initialization failure retries',
  );
  assert(performance.now() - failedAt >= 30000);
  save(file, config);
  await wait(
    () => connected.has('local-test-retry-startup-credential'),
    'repaired configuration recovers',
  );
  assert(performance.now() - failedAt >= 60000);
  const lockedFile = join(dir, 'locked.json');
  save(
    lockedFile,
    settings('local-test-retry-lock-credential', 'shared-state'),
  );
  const locked = launch(lockedFile);
  await wait(
    () => locked.output.includes('STATE_LOCKED'),
    'locked state keeps running',
  );
  assert.equal(locked.child.exitCode, null);
  await stop(entry);
  const releasedAt = performance.now();
  await wait(
    () => connected.has('local-test-retry-lock-credential'),
    'released state lock recovers',
  );
  assert(performance.now() - releasedAt >= 29000);
  await stop(locked);
  const stoppedFile = join(dir, 'stop-startup.json');
  writeFileSync(stoppedFile, '{invalid json', { mode: 0o600 });
  const stopped = launch(stoppedFile);
  await wait(
    () => stopped.output.includes('Agent initialization or runtime failed'),
    'startup retry pending',
  );
  if (process.platform !== 'win32') {
    stopped.child.kill('SIGUSR1');
    await wait(
      () =>
        (stopped.output.match(/Agent initialization or runtime failed/g) ?? [])
          .length >= 2,
      'explicit retry does not exit during initialization backoff',
      5000,
    );
  }
  await stop(stopped, 'SIGINT');
  console.log(
    JSON.stringify({
      scenario: 'initialization-failures',
      invalidConfigRetries: true,
      missingCodexRetries: true,
      stateLockRetries: true,
      repairedConfigRecovers: true,
      stopCancelsInitializationRetry: true,
    }),
  );
}
try {
  await Promise.all([connectionFailures(), initializationFailures()]);
} finally {
  for (const entry of children) {
    if (entry.child.exitCode === null && entry.child.signalCode === null)
      entry.child.kill('SIGTERM');
  }
  await Promise.all(
    children.map(async (entry) => {
      if (entry.child.exitCode === null && entry.child.signalCode === null)
        await new Promise<void>((done) =>
          entry.child.once('exit', () => done()),
        );
    }),
  );
  for (const peer of sockets.clients) peer.terminate();
  await new Promise<void>((done) =>
    sockets.close(() => server.close(() => done())),
  );
  rmSync(dir, { recursive: true, force: true });
}

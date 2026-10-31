// Real Agent/client processes, a simulated relay and a local TUI fixture. No model calls.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';

const root = mkdtempSync(join(tmpdir(), 'coc-configuration-'));
const children: ChildProcess[] = [];
const sockets = new WebSocketServer({ noServer: true });
const peers = new Map<string, WebSocket>();
const connections = { agent: 0, client: 0 };
const pending = new Map<string, (value: any) => void>();
let attaches = 0;
const clientInstances: string[] = [];
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-CoC-Demand', '1');
  if (req.url === '/api/v1/agent/requests')
    res.end(JSON.stringify({ pending: [] }));
  else if (req.url === '/api/v1/sessions/host~session/attach') {
    attaches++;
    res.end(
      JSON.stringify({
        mode: 'cli',
        ticket: 'ticket',
        sandbox: 'workspace-write',
      }),
    );
  } else res.writeHead(404).end('{}');
});
server.on('upgrade', (req, socket, head) =>
  sockets.handleUpgrade(req, socket, head, (ws) =>
    sockets.emit('connection', ws, req),
  ),
);
sockets.on('connection', (ws, req) => {
  const kind =
    req.url === '/ws/v1/agent'
      ? 'agent'
      : req.url?.startsWith('/ws/v1/client-management/')
        ? 'client'
        : 'history';
  ws.send(
    JSON.stringify(
      kind === 'agent'
        ? { type: 'hello', demand: 1, minProtocol: 1 }
        : kind === 'client'
          ? { type: 'management-ready' }
          : { type: 'history-ready' },
    ),
  );
  ws.on('message', (raw) => {
    const value = JSON.parse(String(raw));
    if (value.type === 'capabilities' || value.type === 'management-register') {
      if (kind === 'history')
        throw new Error('Unexpected history registration');
      assert.equal((value.management || value.metadata).kind, kind);
      if (kind === 'client') clientInstances.push(value.metadata.instance);
      peers.set(kind, ws);
      connections[kind]++;
    }
    if (value.type === 'management-result') {
      pending.get(value.wire)?.(value);
      pending.delete(value.wire);
    }
    if (kind === 'history' && value.operation === 'page')
      ws.send(
        JSON.stringify({
          type: 'history',
          events: [],
          snapshotSeq: 0,
          more: false,
        }),
      );
  });
  ws.on('close', () => {
    if (peers.get(kind) === ws) peers.delete(kind);
  });
});
async function waitFor(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 15000;
  while (!predicate()) {
    assert(Date.now() < deadline, message);
    await new Promise((done) => setTimeout(done, 25));
  }
}
async function command(kind: string, data: unknown) {
  const wire = randomUUID();
  return new Promise<any>((done, reject) => {
    const timer = setTimeout(() => {
      pending.delete(wire);
      reject(new Error('Management request timed out'));
    }, 10000);
    pending.set(wire, (value) => {
      clearTimeout(timer);
      done(value);
    });
    peers
      .get(kind)!
      .send(JSON.stringify({ type: 'management-request', wire, data }));
  });
}
function start(
  binary: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
) {
  const child = spawn(resolve(binary), args, {
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  child.stdout!.on('data', (data) => {
    output += data;
  });
  child.stderr!.on('data', (data) => {
    output += data;
  });
  child.on('exit', (code) => {
    if (code) console.error(output);
  });
  return child;
}
try {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const relay = `http://127.0.0.1:${(server.address() as any).port}`;
  const agentPath = join(root, 'agent.json');
  const agentConfig = {
    relayUrl: relay,
    hostId: 'host',
    token: 'test-agent-token-123456789',
    dataDir: join(root, 'state'),
    projects: [],
    autoUpdate: false,
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
  };
  writeFileSync(agentPath, JSON.stringify(agentConfig), { mode: 0o600 });
  const agent = start(process.env.COC_AGENT_BINARY || 'build/coc-agent', [
    'run',
    '--config',
    agentPath,
  ]);
  await waitFor(() => peers.has('agent'), 'Agent did not register');
  const original = (await command('agent', { action: 'read' })).result;
  const replacement = { ...agentConfig, codexUseProxy: true };
  const replace = {
    action: 'replace',
    requestId: randomUUID(),
    revision: original.revision,
    text: JSON.stringify(replacement),
  };
  const replaced = await command('agent', replace);
  assert.equal(replaced.result.state, 'replaced');
  assert.deepEqual((await command('agent', replace)).result, replaced.result);
  const conflict = await command('agent', {
    ...replace,
    requestId: randomUUID(),
    text: '{}',
  });
  assert.equal(conflict.error.code, 'CONFIG_CONFLICT');
  const restart = {
    action: 'restart',
    requestId: randomUUID(),
    revision: replaced.result.revision,
    allowActive: false,
  };
  assert.equal(
    (await command('agent', restart)).result.state,
    'restart-requested',
  );
  await waitFor(() => connections.agent === 2, 'Agent did not restart');
  assert.equal(agent.exitCode, null);
  assert.equal(
    (await command('agent', restart)).result.state,
    'restart-requested',
  );
  assert.deepEqual(JSON.parse(readFileSync(agentPath, 'utf8')), replacement);
  assert.deepEqual(
    JSON.parse(readFileSync(agentPath + '.remote.previous', 'utf8')),
    agentConfig,
  );

  // A fake TUI records each invocation and stays alive until management terminates it.
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const tuiLog = join(root, 'tui.log');
  writeFileSync(
    join(bin, 'codex'),
    `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('codex-cli 0.164.0');else{require('fs').appendFileSync(${JSON.stringify(tuiLog)},process.pid+'\\n');setInterval(()=>{},1000);}\n`,
    { mode: 0o700 },
  );
  const clientPath = join(root, 'credentials.json');
  const credentials = {
    version: 2,
    entries: [
      { relay, hostId: 'host', name: 'Host', token: 'test-client-token' },
    ],
    selected: relay + '~host',
    autoUpdate: false,
  };
  writeFileSync(clientPath, JSON.stringify(credentials), { mode: 0o600 });
  const client = start(
    process.env.COC_CLI_BINARY || 'build/coc-client',
    [
      'attach',
      'host~session',
      '--config',
      clientPath,
      '--cache-dir',
      join(root, 'cache'),
    ],
    { ...process.env, PATH: bin + ':' + process.env.PATH },
  );
  await waitFor(
    () => peers.has('client') && existsSync(tuiLog),
    'Client/TUI did not register',
  );
  const clientOriginal = (await command('client', { action: 'read' })).result;
  assert.equal(clientOriginal.busy, true);
  const clientReplacement = { ...credentials, autoUpdateIntervalHours: 2 };
  const clientReplaced = await command('client', {
    action: 'replace',
    requestId: randomUUID(),
    revision: clientOriginal.revision,
    text: JSON.stringify(clientReplacement),
  });
  assert.equal(clientReplaced.result.state, 'replaced');
  const clientRestart = {
    action: 'restart',
    requestId: randomUUID(),
    revision: clientReplaced.result.revision,
    allowActive: false,
  };
  assert.equal(
    (await command('client', clientRestart)).error.code,
    'SESSION_BUSY',
  );
  clientRestart.allowActive = true;
  assert.equal(
    (await command('client', clientRestart)).result.state,
    'restart-requested',
  );
  await waitFor(
    () =>
      connections.client === 2 &&
      attaches === 2 &&
      readFileSync(tuiLog, 'utf8').trim().split('\n').length === 2,
    'Client did not re-execute original attach command',
  );
  assert.equal(
    clientInstances[0],
    clientInstances[1],
    'Client identity survives original-command restart',
  );
  const pids = readFileSync(tuiLog, 'utf8').trim().split('\n').map(Number);
  assert.throws(() => process.kill(pids[0], 0), /ESRCH/);
  assert.equal(client.exitCode, null);
  assert.equal(
    (await command('client', clientRestart)).result.state,
    'restart-requested',
  );
  await new Promise((done) => setTimeout(done, 2500));
  assert.equal(
    attaches,
    2,
    'Duplicate restart must not repeat the original command again',
  );
  assert.equal(
    connections.agent,
    2,
    'Duplicate Agent restart must not restart again',
  );
  // End the local TUI naturally; its client must disappear without a daemon.
  process.kill(pids[1], 'SIGTERM');
  await waitFor(
    () => client.exitCode !== null && !peers.has('client'),
    'Exited client remains manageable',
  );
  assert.equal(client.exitCode, 1, 'Unsuccessful TUI exit remains an error');
  console.log(
    JSON.stringify({
      agentRestart: 'passed',
      clientOriginalCommand: 'passed',
      tuiCleanup: 'passed',
      duplicateRestart: 'passed',
      offlineClient: 'passed',
      replacementBackup: 'passed',
    }),
  );
} finally {
  const tuiLog = join(root, 'tui.log');
  if (existsSync(tuiLog))
    for (const pid of readFileSync(tuiLog, 'utf8')
      .trim()
      .split('\n')
      .map(Number)) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* The test TUI may already be reaped. */
      }
    }
  const stopped = children.map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((done) =>
      child.once('close', () => done()),
    );
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await closed;
    clearTimeout(timer);
  });
  for (const ws of sockets.clients) ws.terminate();
  await new Promise<void>((done) => sockets.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
  await Promise.all(stopped);
  rmSync(root, { recursive: true, force: true });
}

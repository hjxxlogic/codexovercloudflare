// Two real native Agent processes and both CLIs, using a local simulated relay/Codex.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
const root = mkdtempSync(join(tmpdir(), 'coc-project-integration-'));
const agentBinary = resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent');
const clientBinary = resolve(process.env.COC_CLI_BINARY || 'build/coc-client');
const peers = new Map<string, WebSocket>();
const pending = new Map<string, (message: any) => void>();
const children: ChildProcess[] = [];
let changes = 0;
async function control(host: string, action: string, data: unknown) {
  const requestId = randomUUID();
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Control timed out'));
    }, 10000);
    pending.set(requestId, (message) => {
      clearTimeout(timer);
      if (message.error)
        reject(
          Object.assign(new Error(message.error.message), {
            code: message.error.code,
          }),
        );
      else resolve(message.data);
    });
    peers
      .get(host)!
      .send(JSON.stringify({ type: 'control', action, data, requestId }));
  });
}
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-CoC-Demand', '1');
  const host = req.headers.authorization?.includes('bob') ? 'bob' : 'alice';
  try {
    if (req.url === '/api/v1/agent/requests')
      res.end(JSON.stringify({ hostId: host, pending: [] }));
    else if (req.url === '/api/v1/hosts')
      res.end(JSON.stringify([{ id: host, name: host, online: true }]));
    else if (req.url === `/api/v1/hosts/${host}/project-management`) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data =
        req.method === 'GET' ? { operation: 'list' } : JSON.parse(body);
      res.end(JSON.stringify(await control(host, 'projectManage', data)));
    } else res.writeHead(404).end('{}');
  } catch (e: any) {
    res
      .writeHead(409)
      .end(JSON.stringify({ error: { code: e.code, message: e.message } }));
  }
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (ws, req) => {
  const host = req.headers.authorization?.includes('bob') ? 'bob' : 'alice';
  ws.send(JSON.stringify({ type: 'hello', minProtocol: 1, demand: 1 }));
  ws.on('message', (raw) => {
    const d = JSON.parse(String(raw));
    if (d.type === 'capabilities') peers.set(host, ws);
    if (d.type === 'projects-changed') changes++;
    if (d.type === 'result') {
      const cb = pending.get(d.requestId);
      pending.delete(d.requestId);
      cb?.(d);
    }
  });
  ws.on('close', () => {
    if (peers.get(host) === ws) peers.delete(host);
  });
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const relay = `http://127.0.0.1:${(server.address() as any).port}`;
function config(host: string) {
  return join(root, host + '.json');
}
async function waitFor(predicate: () => boolean, message: string) {
  const until = Date.now() + 10000;
  while (!predicate()) {
    assert(Date.now() < until, message);
    await new Promise((r) => setTimeout(r, 30));
  }
}
async function command(binary: string, args: string[], expected = 0) {
  const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '',
    error = '';
  child.stdout.on('data', (d) => (output += d));
  child.stderr.on('data', (d) => (error += d));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  const code = await new Promise<number | null>((r) => child.on('close', r));
  clearTimeout(timer);
  assert.equal(code, expected, `${args.join(' ')}: ${error}`);
  return JSON.parse(expected ? error.trim().split('\n').at(-1)! : output);
}
async function start(host: string) {
  const child = spawn(agentBinary, ['run', '--config', config(host)], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let log = '';
  child.stdout!.on('data', (d) => (log += d));
  child.stderr!.on('data', (d) => (log += d));
  await waitFor(
    () => peers.has(host) || child.exitCode !== null,
    `Agent ${host} failed: ${log}`,
  );
  assert.equal(child.exitCode, null, log);
  return child;
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  const closed = new Promise((r) => child.on('close', r));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  await closed;
  clearTimeout(timer);
  assert.equal(child.exitCode, 0, 'Agent stops gracefully');
}
try {
  for (const host of ['alice', 'bob'])
    writeFileSync(
      config(host),
      JSON.stringify({
        relayUrl: relay,
        hostId: host,
        token: `local-test-${host}-credential`,
        dataDir: join(root, host + '-state'),
        projects: [],
        autoUpdate: false,
        codexPath: process.execPath,
        codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
        sandbox: 'workspace-write',
      }),
      { mode: 0o600 },
    );
  const a = await start('alice'),
    b = await start('bob');
  const local = (host: string, args: string[], expected = 0) =>
    command(
      agentBinary,
      ['project', ...args, '--config', config(host)],
      expected,
    );
  const one = join(root, 'one'),
    two = join(root, 'two');
  await local('alice', ['add', one, '--mkdir', '--project-id', 'one']);
  assert.equal((await local('bob', ['list'])).projects.length, 0);
  const session = await control('alice', 'create', {
    key: 'create-test',
    projectId: 'one',
    mode: 'web',
  });
  assert.equal(
    (await local('alice', ['remove', 'one'], 1)).code,
    'PROJECT_BUSY',
  );
  const clientConfig = join(root, 'client.json');
  writeFileSync(
    clientConfig,
    JSON.stringify({
      version: 2,
      autoUpdate: false,
      entries: [
        { relay, hostId: 'alice', token: 'local-test-client', name: 'alice' },
      ],
      selected: relay + '~alice',
    }),
    { mode: 0o600 },
  );
  const remote = (args: string[]) =>
    command(clientBinary, [
      'project',
      ...args,
      '--host',
      'alice',
      '--config',
      clientConfig,
    ]);
  await remote(['add', two, '--mkdir', '--project-id', 'two']);
  assert.equal((await remote(['list'])).projects.length, 2);
  await remote(['rename', 'two', 'Second project']);
  const rename = {
    operation: 'rename',
    id: 'two',
    name: 'Retry-safe',
    revision: 3,
    requestId: 'repeat-rename',
  };
  const original = await control('alice', 'projectManage', rename);
  assert.deepEqual(await control('alice', 'projectManage', rename), original);
  await assert.rejects(
    control('alice', 'projectManage', { ...rename, name: 'changed' }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );
  await control('alice', 'stop', { sessionId: session.id });
  await new Promise((r) => setTimeout(r, 300));
  await local('alice', ['remove', 'one']);
  assert(existsSync(one), 'Unregister never removes files');
  renameSync(two, join(root, 'moved'));
  await stop(a);
  const restarted = await start('alice');
  const listed = await local('alice', ['list']);
  assert.equal(listed.projects[0].id, 'two');
  assert.equal(listed.projects[0].available, false);
  assert.equal((await local('bob', ['list'])).projects.length, 0);
  assert(changes >= 5, 'Catalog mutations notify relay');
  await stop(restarted);
  await stop(b);
  await local('alice', ['remove', 'two']);
  assert.equal((await local('alice', ['list'])).projects.length, 0);
  console.log(
    'PASS: two native Agents, live local/remote commands, active-session protection, retries and restart',
  );
} finally {
  for (const child of children)
    if (child.exitCode === null) child.kill('SIGKILL');
  for (const peer of sockets.clients) peer.terminate();
  await new Promise<void>((done) =>
    sockets.close(() => server.close(() => done())),
  );
  rmSync(root, { recursive: true, force: true });
}

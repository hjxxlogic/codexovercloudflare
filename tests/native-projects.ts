// Two real native Agent processes and both CLIs, using a local simulated relay/Codex.
import assert from 'node:assert/strict';
import { operationWrite } from '../packages/protocol/src/index.ts';
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
const instances = new Map<string, string>();
const pending = new Map<string, (message: any) => void>();
const receipts = new Map<string, any>();
const children: ChildProcess[] = [];
let changes = 0;
async function control(
  host: string,
  action: string,
  data: unknown,
  intent?: unknown,
) {
  const requestId = randomUUID();
  const args = data as any;
  const envelope = !!intent;
  if (!intent && operationWrite(action, args))
    intent = {
      requestId: args.requestId || args.key || requestId,
      owner: 'a'.repeat(64),
      instance: (await control(host, 'probe', {})).operationInstance,
    };
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error('Control timed out'));
    }, 10000);
    pending.set(requestId, (message) => {
      clearTimeout(timer);
      if (envelope) {
        resolve({
          state: 'completed',
          ...(message.error
            ? { error: message.error }
            : { result: message.data }),
          ...(message.intent ? { intent: message.intent } : {}),
        });
        return;
      }
      if (message.error)
        reject(
          Object.assign(new Error(message.error.message), {
            code: message.error.code,
          }),
        );
      else resolve(message.data);
    });
    peers.get(host)!.send(
      JSON.stringify({
        type: 'control',
        action,
        data,
        requestId,
        ...(intent ? { intent } : {}),
      }),
    );
  });
}
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-CoC-Demand', '1');
  res.setHeader('X-CoC-Delivery', '2');
  const host = req.headers.authorization?.includes('bob') ? 'bob' : 'alice';
  try {
    if (req.url === '/api/v1/agent/requests')
      res.end(JSON.stringify({ hostId: host, pending: [] }));
    else if (req.url === '/api/v1/hosts')
      res.end(JSON.stringify([{ id: host, name: host, online: true }]));
    else if (req.url === `/api/v1/hosts/${host}/probe`)
      res.end(JSON.stringify(await control(host, 'probe', {})));
    else if (req.url?.startsWith(`/api/v1/hosts/${host}/operations/`)) {
      const id = req.url.split('/').at(-1)!;
      if (req.method === 'POST') {
        receipts.delete(id);
        res.end('{}');
      } else res.end(JSON.stringify(receipts.get(id) || { state: 'pending' }));
    } else if (req.url === `/api/v1/hosts/${host}/project-management`) {
      let body = '';
      for await (const chunk of req) body += chunk;
      const data =
        req.method === 'GET' ? { operation: 'list' } : JSON.parse(body);
      const instance = req.headers['x-coc-operation-instance'];
      if (instance) {
        const id = 'delivery_' + randomUUID();
        const intent = {
          instance,
          requestId: req.headers['idempotency-key'],
          owner: 'a'.repeat(64),
          ...(req.headers['x-coc-operation-ack'] === '1' ? { ack: true } : {}),
        };
        receipts.set(id, await control(host, 'projectManage', data, intent));
        res
          .writeHead(202)
          .end(
            JSON.stringify({ accepted: true, operationId: id, hostId: host }),
          );
      } else
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
  ws.send(
    JSON.stringify({ type: 'hello', delivery: 2, minProtocol: 1, demand: 1 }),
  );
  ws.on('message', (raw) => {
    const d = JSON.parse(String(raw));
    if (d.type === 'capabilities') {
      peers.set(host, ws);
      void control(host, 'probe', {}).then((probe) =>
        instances.set(host, probe.operationInstance),
      );
    }
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
  const child = spawn(binary, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COC_HISTORY_DIR: join(root, 'history') },
  });
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
  const otherOwner = await control(
    'alice',
    'projectManage',
    {
      ...rename,
      revision: 4,
      name: 'Another authenticated owner',
    },
    {
      requestId: rename.requestId,
      owner: 'b'.repeat(64),
      instance: instances.get('alice'),
    },
  );
  assert.equal(
    otherOwner.result.revision,
    5,
    'The Agent passes the verified owner into the project journal',
  );
  assert.deepEqual(
    await control('alice', 'projectManage', rename),
    original,
    'Another owner cannot replace the original project result',
  );
  const localSameId = await local('alice', [
    'rename',
    'two',
    'Explicit local intent',
    '--request-id',
    rename.requestId,
    '--revision',
    '5',
  ]);
  assert.equal(
    localSameId.revision,
    6,
    'Local control has a server-selected namespace independent of remote owners',
  );
  const extraSessions = [];
  for (let i = 0; i < 15; i++)
    extraSessions.push(
      await control('alice', 'create', {
        key: `quota-session-${i}`,
        projectId: 'one',
        mode: 'web',
      }),
    );
  // The seventeenth runtime is refused, while the independent reader still
  // works at full runtime capacity. No phantom failed session is persisted.
  const beforeFull = await control('alice', 'list', {});
  await assert.rejects(
    control('alice', 'create', { projectId: 'one', mode: 'web' }),
    (error: any) => error.code === 'BACKPRESSURE',
  );
  assert.equal((await control('alice', 'list', {})).length, beforeFull.length);
  await control('alice', 'threads', { projectId: 'one' });
  for (const extra of extraSessions)
    await control('alice', 'stop', { sessionId: extra.id });
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
  for (let i = 0; i < 22; i++)
    await local('alice', [
      'add',
      join(root, `quota-${i}`),
      '--mkdir',
      '--project-id',
      `quota-${i}`,
    ]);
  assert.equal((await local('alice', ['list'])).projects.length, 22);
  const quotaRestart = await start('alice');
  assert.equal((await local('alice', ['list'])).projects.length, 22);
  await stop(quotaRestart);
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

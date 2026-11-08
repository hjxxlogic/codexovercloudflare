// Real Agent endpoint, original request receipts, restart and role/project isolation.
// Every Codex record and project belongs to a disposable temporary directory.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { AgentEndpoint } from './helpers/agent-endpoint.ts';
const root = mkdtempSync(join(tmpdir(), 'coc-thread-endpoint-'));
const config = join(root, 'agent.json');
const catalogFile = join(root, '.thread-management.json');
let child: ChildProcess | undefined;
let peer: AgentEndpoint | undefined;
let log = '';
const frames: any[] = [];
const server = createServer((_req, response) =>
  response
    .writeHead(200, {
      'Content-Type': 'application/json',
      'X-CoC-Demand': '1',
      'X-CoC-Delivery': '2',
    })
    .end('{"pending":[]}'),
);
const sockets = new WebSocketServer({ server });
sockets.on('connection', (raw) => {
  const endpoint = new AgentEndpoint(raw, 'host');
  endpoint.on('message', (raw) => {
    const frame = JSON.parse(String(raw));
    frames.push(frame);
    if (frame.type === 'capabilities') peer = endpoint;
  });
  endpoint.on('close', () => {
    if (peer === endpoint) peer = undefined;
  });
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
writeFileSync(
  config,
  JSON.stringify({
    relayUrl: `http://127.0.0.1:${(server.address() as any).port}`,
    hostId: 'host',
    token: 'thread-endpoint-fixture',
    dataDir: join(root, 'state'),
    autoUpdate: false,
    projects: [{ id: 'project', name: 'Project', path: root }],
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/thread-management.mjs')],
  }),
  { mode: 0o600 },
);
const read = () => JSON.parse(readFileSync(catalogFile, 'utf8'));
const write = (state: any) => writeFileSync(catalogFile, JSON.stringify(state));
const thread = (id: string) => ({
  id,
  cwd: root,
  createdAt: 1,
  status: { type: 'notLoaded' },
  archived: false,
});
async function until(predicate: () => any) {
  const deadline = Date.now() + 20000;
  while (!predicate()) {
    assert(Date.now() < deadline, 'Timed out: ' + log.slice(-2000));
    await new Promise((done) => setTimeout(done, 20));
  }
}
async function start() {
  child = spawn(resolve('build/coc-agent'), ['run', '--config', config], {
    env: { ...process.env, COC_NO_STARTUP_REPAIR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout!.on('data', (data) => (log += data));
  child.stderr!.on('data', (data) => (log += data));
  await until(() => peer);
}
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = new Promise((done) => child!.once('close', done));
    child.kill('SIGKILL');
    await closed;
  }
  peer = undefined;
}
async function control(action: string, data: unknown, intent?: unknown) {
  const requestId = randomUUID();
  assert(peer);
  peer.send(
    JSON.stringify({
      type: 'control',
      requestId,
      action,
      data,
      ...(intent ? { intent } : {}),
    }),
  );
  await until(() =>
    frames.some((f) => f.type === 'result' && f.requestId === requestId),
  );
  return frames.find((f) => f.type === 'result' && f.requestId === requestId);
}
let db: DatabaseSync | undefined;
try {
  write({ threads: [thread('thread')] });
  await start();
  db = new DatabaseSync(join(root, 'state', 'agent.db'));
  const instance = (await control('probe', {})).data.operationInstance;
  const intent = () => ({
    instance,
    owner: 'a'.repeat(64),
    requestId: randomUUID(),
  });
  const body = (operation: string, extra = {}) => ({
    projectId: 'project',
    threadId: 'thread',
    operation,
    mode: 'web',
    ...extra,
  });
  const before = await control('threadManage', body('archive'));
  assert.equal(
    before.error.code,
    'UPGRADE_REQUIRED',
    'Mutations need durable original identity',
  );
  const noConfirm = await control('threadManage', body('delete'), intent());
  assert.equal(noConfirm.error.code, 'CONFIRMATION_REQUIRED');
  const foreign = await control(
    'threadManage',
    body('archive', { projectId: 'not-allowed' }),
    intent(),
  );
  assert(foreign.error, 'Unregistered project is rejected');
  const save = (state: string, mode = 'web') =>
    db!.prepare('INSERT OR REPLACE INTO sessions(id,value) VALUES(?,?)').run(
      'host~session',
      JSON.stringify({
        id: 'host~session',
        projectId: 'project',
        threadId: 'thread',
        mode,
        state,
        running: false,
        createdAt: 1,
      }),
    );
  save('ready');
  assert.equal(
    (await control('threadManage', body('archive'), intent())).error.code,
    'SESSION_BUSY',
  );
  save('closed', 'cli');
  assert.equal(
    (await control('threadManage', body('archive'), intent())).error.code,
    'FORBIDDEN',
    'Web credentials cannot mutate CLI associations',
  );
  save('closed');
  const original = intent();
  const archived = await control('threadManage', body('archive'), original);
  assert(!archived.error, JSON.stringify(archived));
  assert.equal(archived.data.archived, true);
  assert(archived.intent, 'Mutation commits original receipt');
  const repeated = await control('threadManage', body('archive'), original);
  assert.deepEqual(repeated.data, archived.data);
  assert.equal(read().mutations, 1, 'Repeated original cannot archive twice');
  const resume = await control(
    'create',
    { projectId: 'project', mode: 'web', threadId: 'thread' },
    intent(),
  );
  assert.equal(
    resume.error.code,
    'THREAD_ARCHIVED',
    'Archived thread requires explicit unarchive',
  );
  const activeList = await control('threads', {
    projectId: 'project',
    archived: false,
  });
  const archivedList = await control('threads', {
    projectId: 'project',
    archived: true,
  });
  // The helper uses POST parameters; the production browser/CLI use query parameters.
  assert(!activeList.error && !archivedList.error);
  assert.equal(archivedList.data.data[0].archived, true);
  assert.equal(
    (await control('threadManage', body('unarchive'), intent())).data.archived,
    false,
  );
  const state = read();
  state.dropReply = true;
  write(state);
  const deletion = intent();
  const deleting = body('delete', { confirm: true });
  const lost = await control('threadManage', deleting, deletion);
  assert.equal(lost.error.code, 'RESULT_UNKNOWN');
  assert(!lost.intent, 'Unconfirmed result cannot be acknowledged as terminal');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM transport2_thread_jobs').get()!.n,
    1,
  );
  await stop();
  await start();
  const recovered = await control('threadManage', deleting, deletion);
  assert(!recovered.error, JSON.stringify(recovered));
  assert.equal(recovered.data.deleted, true);
  assert(recovered.intent);
  assert.equal(
    read().mutations,
    3,
    'Restart verifies the original delete without redispatch',
  );
  assert.equal(
    (await control('get', { sessionId: 'host~session', mode: 'web' })).error
      .code,
    'SESSION_DELETED',
  );
  const listed = await control('list', { mode: 'web', paged: true });
  assert.equal(listed.data.data[0].deleted, true);
  assert.equal(
    (
      await control(
        'create',
        { projectId: 'project', mode: 'web', threadId: 'thread' },
        intent(),
      )
    ).error.code,
    'SESSION_DELETED',
  );
  assert.equal(
    (await control('threadManage', deleting, { ...deletion, ack: true })).error,
    undefined,
  );
  console.log(
    'PASS: archive/unarchive/delete through encrypted Agent endpoint; confirmation, role/project/busy checks, tombstones, durable receipts and restart without redispatch',
  );
} finally {
  await stop();
  db?.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((done) => sockets.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
}

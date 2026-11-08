// Real encrypted endpoint + native Agent; isolated retention faults, no model calls.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { AgentEndpoint } from './helpers/agent-endpoint.ts';
import { EndpointPeer } from './helpers/endpoint-peer.ts';
import { WindowPeer } from './helpers/window-peer.ts';

const root = mkdtempSync(join(tmpdir(), 'coc-history-subscription-'));
let agent: AgentEndpoint | undefined;
let child: ChildProcess | undefined;
let database: DatabaseSync | undefined;
let log = '';
let connections = 0;
const peers: EndpointPeer[] = [];
const server = createServer((_request, response) =>
  response
    .writeHead(200, { 'Content-Type': 'application/json' })
    .end('{"pending":[]}'),
);
const sockets = new WebSocketServer({ server });
sockets.on('connection', (socket, request) => {
  if (request.url?.startsWith('/ws/v1/channel/')) {
    assert(agent);
    agent.route(socket, 'web');
    return;
  }
  connections++;
  const endpoint = new AgentEndpoint(socket, 'host');
  endpoint.on('message', (raw) => {
    if (JSON.parse(String(raw)).type === 'capabilities') agent = endpoint;
  });
});
async function until(test: () => unknown, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!test()) {
    assert(Date.now() < end, label + '\n' + log.slice(-2000));
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function stream(path: string, frames: any[]) {
  const peer = new EndpointPeer(origin, 'host', {}, { type: 'open', path });
  peers.push(peer);
  peer.on('message', (raw) => frames.push(JSON.parse(String(raw))));
  await new Promise<void>((resolve, reject) => {
    peer.once('open', resolve);
    peer.once('error', reject);
  });
  return peer;
}
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
try {
  const config = join(root, 'agent.json');
  writeFileSync(
    config,
    JSON.stringify({
      relayUrl: origin,
      hostId: 'host',
      token: 'history-subscription-test-credential',
      dataDir: join(root, 'state'),
      autoUpdate: false,
      projects: [{ id: 'project', name: 'Project', path: root }],
      codexPath: process.execPath,
      codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    }),
    { mode: 0o600 },
  );
  child = spawn(
    resolve('build/coc-agent' + (process.platform === 'win32' ? '.exe' : '')),
    ['run', '--config', config, '--proxy', ''],
    {
      env: {
        ...process.env,
        CODEX_HOME: join(root, '.codex'),
        COC_NO_STARTUP_REPAIR: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout!.on('data', (data) => {
    log += data;
  });
  child.stderr!.on('data', (data) => {
    log += data;
  });
  await until(() => agent, 'Agent registration');
  async function call(path: string, body: any = null, intent?: any) {
    const response = await agent!.call(path, body, 'web', intent);
    assert.equal(response.error, undefined, JSON.stringify(response));
    return response.data;
  }
  const probe = await call('/hosts/host/probe');
  const session = await call(
    '/sessions',
    { hostId: 'host', projectId: 'project', mode: 'web' },
    {
      owner: 'a'.repeat(64),
      requestId: randomUUID(),
      instance: probe.operationInstance,
    },
  );
  const claim = await call(`/sessions/${session.id}/attach`, {
    claimId: randomUUID(),
    delivery: 2,
  });
  const messages: any[] = [];
  const controller = await stream(`/ws/v1/web/${session.id}`, messages);
  controller.send(JSON.stringify({ type: 'auth', ticket: claim.ticket }));
  await until(
    () => messages.some((d) => d.type === 'attached'),
    'Attach controller',
  );
  const attached = messages.find((d) => d.type === 'attached');
  const window = new WindowPeer(
    controller as any,
    messages,
    'web',
    attached.control,
  );
  await until(() => window.ready, 'Delivery windows');
  database = new DatabaseSync(join(root, 'state', 'agent.db'));
  const state = () =>
    JSON.parse(
      String(
        database!
          .prepare('SELECT value FROM sessions WHERE id=?')
          .get(session.id)!.value,
      ),
    );
  window.send(
    JSON.stringify({ action: 'prompt', requestId: randomUUID(), text: 'hold' }),
  );
  await until(() => state().running && state().turnId, 'Held task is running');
  const originalTurn = state().turnId;
  const history: any[] = [];
  const reader = await stream(`/ws/v1/history/${session.id}`, history);
  const subscribe = () => ({
    operation: 'subscribe',
    requestId: randomUUID(),
    stream: randomUUID(),
    instance: randomUUID(),
    exchangeId: randomUUID(),
    receivedRevision: 0,
    acknowledgedRevision: 0,
  });
  const first = subscribe();
  reader.send(JSON.stringify(first));
  await until(
    () =>
      history.some(
        (d) => d.type === 'history-window' && d.requestId === first.requestId,
      ),
    'History window',
  );
  await until(
    () =>
      history.some(
        (d) => d.type === 'history-dirty' && d.stream === first.stream,
      ),
    'History retry scheduled',
  );
  // Simulate capacity cleanup of only this fixture's durable subscription.
  const evict = (subscription: typeof first) => {
    assert.equal(
      database!
        .prepare(
          'DELETE FROM transport2_history_subscriptions WHERE stream=? AND instance=?',
        )
        .run(subscription.stream, subscription.instance).changes,
      1,
    );
  };
  evict(first);
  const expired = (subscription: typeof first) =>
    history.filter(
      (d) =>
        d.type === 'error' &&
        d.error?.code === 'HISTORY_SUBSCRIPTION_EXPIRED' &&
        d.stream === subscription.stream &&
        d.instance === subscription.instance,
    );
  await until(
    () => expired(first).length === 1,
    'Timer must notify subscription expiry without closing the task',
  );
  assert.equal(expired(first)[0].exchangeId, first.exchangeId);
  assert.equal(state().running, true);
  assert.equal(state().turnId, originalTurn);
  // A replacement identity can resubscribe on the same encrypted stream.
  const second = subscribe();
  reader.send(JSON.stringify(second));
  await until(
    () =>
      history.some(
        (d) => d.type === 'history-window' && d.requestId === second.requestId,
      ),
    'Replacement subscription',
  );
  const opened = history.find(
    (d) => d.type === 'history-window' && d.requestId === second.requestId,
  );
  const ack = {
    ...second,
    operation: 'ack',
    requestId: randomUUID(),
    receivedRevision: opened.maxRevision,
    agentInstance: opened.agentInstance,
    streamSerial: opened.streamSerial,
    creditGeneration: opened.creditGeneration,
  };
  reader.send(JSON.stringify(ack));
  await until(
    () =>
      history.some(
        (d) => d.type === 'history-window' && d.requestId === ack.requestId,
      ),
    'Fully acknowledge history',
  );
  // With no dirty retry pending, publication must also handle subscription eviction.
  evict(second);
  const modelRequest = randomUUID();
  window.send(
    JSON.stringify({
      action: 'models',
      requestId: modelRequest,
      cursor: 'scope-budget-history',
    }),
  );
  await until(
    () => expired(second).length === 1,
    'Event publication must notify subscription expiry',
  );
  await until(
    () => messages.some((d) => d.requestId === modelRequest),
    'Controller remains usable',
  );
  await call('/hosts/host/probe');
  assert.equal(expired(second)[0].exchangeId, second.exchangeId);
  assert.equal(expired(second).length, 1, 'Publication retires the route once');
  assert.equal(
    expired(first).length,
    1,
    'An expired route is not notified repeatedly',
  );
  assert.equal(state().running, true);
  assert.equal(state().turnId, originalTurn);
  assert.equal(state().state, 'ready');
  assert.equal(connections, 1, 'No Agent runtime reconnect');
  assert.doesNotMatch(
    log,
    /history_retry_failure|executor_failure|storage_fault|runtime failed/,
  );
  assert.equal(child.exitCode, null);
  // The held task remains controllable after both notification paths.
  window.send(
    JSON.stringify({
      action: 'interrupt',
      requestId: randomUUID(),
      target: state().activeTask,
    }),
  );
  await until(
    () => !state().running,
    'Interrupt held task after subscription recovery',
  );
  assert.equal(state().state, 'ready');
  console.log(
    'PASS: encrypted history subscription eviction, timer/publication notices, resubscribe and running task isolation',
  );
} finally {
  database?.close();
  for (const peer of peers) peer.terminate();
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child!.once('exit', r));
    child.kill('SIGTERM');
    const force = setTimeout(() => child!.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(force);
  }
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((r) => sockets.close(() => r()));
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(root, { recursive: true, force: true });
}

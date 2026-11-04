import { encryptedFixture } from './helpers/encrypted-fixture.ts';
// Deterministic native wake checks with a local relay peer; no model calls.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'coc-wake-'));
let online = false,
  configured = true,
  wakes = 0,
  stopCalls = 0;
const stopKeys: string[] = [];
let agentUrl = '';
const receipts = new Map<string, unknown>();
const instance = 'wake-agent-storage';
const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-CoC-Demand', '1');
  res.setHeader('X-CoC-Delivery', '2');
  const reply = (value: unknown, status = 200) => {
    res.statusCode = status;
    res.end(JSON.stringify(value));
  };
  if (req.url === '/api/v1/agent/requests') {
    assert.equal(
      req.headers.authorization,
      'Bearer agent-test-token-placeholder',
    );
    reply({ pending: [], hostId: 'host' });
    return;
  }
  if (req.url === '/api/v1/agent/wake-url') {
    assert.equal(
      req.headers.authorization,
      'Bearer agent-test-token-placeholder',
    );
    let body = '';
    for await (const chunk of req) body += chunk;
    agentUrl = JSON.parse(body).wakeUrl;
    reply({ ok: true });
    return;
  }
  assert.equal(req.headers.authorization, 'Bearer cli-test-token-placeholder');
  if (req.url === '/api/v1/hosts')
    reply([{ id: 'host', name: 'Test', online, wakeConfigured: configured }]);
  else if (req.url === '/api/v1/hosts/host/wake') {
    assert.equal(req.method, 'POST');
    wakes++;
    online = configured;
    reply({ state: configured ? 'requested' : 'unconfigured' });
  } else if (req.url === '/api/v1/hosts/host/probe') {
    reply({
      online,
      confirmedAt: Date.now(),
      deliveryInstance: instance,
      operationInstance: instance,
    });
  } else if (req.url === '/api/v1/hosts/host/projects') {
    assert(online);
    reply([{ id: 'project' }]);
  } else if (req.url?.startsWith('/api/v1/hosts/host/operations/')) {
    const id = req.url.split('/')[6];
    if (req.method === 'POST') {
      receipts.delete(id);
      reply({ ok: true });
    } else reply(receipts.get(id));
  } else if (req.url === '/api/v1/sessions/host~session/stop') {
    const ack = req.headers['x-coc-operation-ack'] === '1';
    const id = String(req.headers['idempotency-key']);
    assert.equal(req.headers['x-coc-operation-instance'], instance);
    if (!ack) stopKeys.push(id);
    if (!ack && ++stopCalls === 1) {
      online = false;
      reply({ error: { code: 'HOST_OFFLINE', message: 'Offline' } }, 503);
    } else {
      const wire = 'delivery_' + randomUUID();
      receipts.set(wire, {
        state: 'completed',
        result: ack ? { confirmed: true } : { ok: true },
        intent: {
          requestId: id,
          instance,
          owner: 'a'.repeat(64),
          ...(ack ? { ack: true } : {}),
        },
      });
      reply({ accepted: true, hostId: 'host', operationId: wire }, 202);
    }
  } else reply({ error: { code: 'NOT_FOUND' } }, 404);
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  if (
    req.url?.startsWith('/ws/v1/channel/') ||
    req.url?.startsWith('/ws/v1/client-management/')
  ) {
    (req as any).endpointOffline = !online;
    encryptedFixture(ws, req);
  }
});
let agent: ChildProcess | undefined;
async function run(binary: string, args: string[]) {
  const child = spawn(resolve(binary), args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, COC_HISTORY_DIR: join(dir, 'history') },
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => (stderr += data));
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  try {
    return {
      code: await new Promise((done) => child.once('exit', done)),
      stdout,
      stderr,
    };
  } finally {
    clearTimeout(timer);
  }
}
try {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const cliConfig = join(dir, 'cli.json'),
    agentConfig = join(dir, 'agent.json');
  writeFileSync(
    cliConfig,
    JSON.stringify({
      version: 2,
      autoUpdate: false,
      selected: origin + '~host',
      entries: [
        {
          relay: origin,
          hostId: 'host',
          name: 'Test',
          role: 'cli',
          token: 'cli-test-token-placeholder',
        },
      ],
    }),
    { mode: 0o600 },
  );
  const cli = (...args: string[]) =>
    run(process.env.COC_CLI_BINARY || 'build/coc-client', [
      ...args,
      '--config',
      cliConfig,
    ]);
  let result = await cli('projects');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].id, 'project');
  assert.equal(wakes, 1);
  assert.match(result.stderr, /wake requested/);
  result = await cli('stop', 'host~session');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(wakes, 2);
  assert.equal(stopCalls, 2);
  assert.equal(
    stopKeys[0],
    stopKeys[1],
    'offline retry preserves idempotency identity',
  );
  for (const command of ['status', 'hosts']) {
    online = false;
    result = await cli(command);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout)[0].wake.state, 'requested');
  }
  assert.equal(wakes, 4);
  configured = false;
  online = false;
  result = await cli('projects');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /HOST_OFFLINE.*no wake URL/);
  writeFileSync(
    agentConfig,
    JSON.stringify({
      relayUrl: origin,
      hostId: 'host',
      token: 'agent-test-token-placeholder',
      autoUpdate: false,
      dataDir: join(dir, 'state'),
      codexPath: process.execPath,
      codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
      projects: [{ id: 'project', name: 'Test', path: dir }],
    }),
    { mode: 0o600 },
  );
  const configure = (url: string) =>
    run(process.env.COC_AGENT_BINARY || 'build/coc-agent', [
      'wake-url',
      url,
      '--config',
      agentConfig,
    ]);
  result = await configure('https://wake.test/start?key=secret');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(agentUrl, 'https://wake.test/start?key=secret');
  assert.equal(JSON.parse(readFileSync(agentConfig, 'utf8')).wakeUrl, agentUrl);
  result = await configure('http://insecure.example/start');
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(readFileSync(agentConfig, 'utf8')).wakeUrl, agentUrl);
  const advertised = new Promise<string>((done, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Agent did not advertise wake URL')),
      10000,
    );
    wss.on('connection', (ws, req) => {
      if (
        req.url?.startsWith('/ws/v1/channel/') ||
        req.url?.startsWith('/ws/v1/client-management/')
      )
        return;
      ws.send(
        JSON.stringify({
          type: 'channel-welcome',
          delivery: 2,
          demand: 1,
          minProtocol: 1,
        }),
      );
      ws.on('message', (raw) => {
        if (JSON.parse(String(raw)).type === 'channel-register')
          ws.send(JSON.stringify({ type: 'channel-registered' }));
      });
      ws.on('message', (raw) => {
        const frame = JSON.parse(raw.toString());
        if (frame.type === 'channel-register') {
          clearTimeout(timeout);
          done(frame.wakeUrl);
        }
      });
    });
  });
  agent = spawn(
    resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent'),
    ['run', '--config', agentConfig],
    { stdio: 'ignore' },
  );
  assert.equal(await advertised, agentUrl);
  await new Promise<void>((done) => {
    agent!.once('exit', () => done());
    agent!.kill('SIGTERM');
  });
  agent = undefined;
  result = await configure('');
  assert.equal(result.code, 0, result.stderr);
  assert.equal(agentUrl, '');
  console.log(
    'PASS: native Agent configuration/advertisement/clearing, CC wake/wait/retry identity, status/hosts, unconfigured host',
  );
} finally {
  agent?.kill('SIGTERM');
  for (const ws of wss.clients) ws.terminate();
  await new Promise<void>((done) => wss.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
  rmSync(dir, { recursive: true, force: true });
}

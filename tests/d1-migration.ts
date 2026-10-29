import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import WebSocket from 'ws';
import { localStateConfig } from '../scripts/state-config.ts';

const directory = mkdtempSync(join(tmpdir(), 'coc-d1-migration-'));
const secret = randomBytes(32).toString('hex');
const listener = createServer();
await new Promise<void>((done) => listener.listen(0, '127.0.0.1', done));
const port = (listener.address() as any).port;
await new Promise<void>((done) => listener.close(() => done()));
const origin = `http://127.0.0.1:${port}`;
let worker: ChildProcess | undefined;
let logs = '';
let agent: WebSocket | undefined;
const persist = join(directory, 'state');
const wrangler = 'node_modules/wrangler/bin/wrangler.js';
async function wait(check: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('Timeout: ' + label);
}
async function stop() {
  if (!worker || worker.exitCode !== null) return;
  const exited = once(worker, 'exit');
  process.kill(-worker.pid!, 'SIGTERM');
  await exited;
  worker = undefined;
}
async function start(d1: boolean) {
  const config = join(directory, 'wrangler.json');
  if (d1) {
    localStateConfig(config);
    const result = spawnSync(
      process.execPath,
      [
        wrangler,
        'd1',
        'migrations',
        'apply',
        'STATE_DB',
        '--local',
        '--config',
        config,
        '--persist-to',
        persist,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } else {
    const legacy = JSON.parse(
      readFileSync('wrangler.jsonc', 'utf8').replace(/,(\s*[}\]])/g, '$1'),
    );
    legacy.main = resolve(legacy.main);
    legacy.assets.directory = resolve(legacy.assets.directory);
    writeFileSync(config, JSON.stringify(legacy));
  }
  worker = spawn(
    process.execPath,
    [
      wrangler,
      'dev',
      '--config',
      config,
      '--persist-to',
      persist,
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--var',
      'ACCESS_ENABLED:false',
      '--var',
      'OWNER_SECRET:' + secret,
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    },
  );
  worker.stdout!.on('data', (data) => {
    logs += data;
  });
  worker.stderr!.on('data', (data) => {
    logs += data;
  });
  await wait(async () => {
    try {
      return (
        await fetch(origin + '/api/v1/healthz', {
          signal: AbortSignal.timeout(1000),
        })
      ).ok;
    } catch {
      return false;
    }
  }, 'Worker startup');
}
async function request(path: string, credential: string, data?: unknown) {
  const response = await fetch(origin + '/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: 'Bearer ' + credential,
      Origin: origin,
      'X-CoC-Async': '1',
      'Content-Type': 'application/json',
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const value: any = await response.json();
  assert.ok(response.ok, JSON.stringify(value));
  return value;
}
async function connect(key: string) {
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/ws/v1/agent', {
    headers: { Authorization: 'Bearer ' + key },
  });
  const hello = once(ws, 'message');
  await once(ws, 'open');
  const epoch = JSON.parse((await hello)[0].toString()).epoch;
  ws.send(
    JSON.stringify({
      type: 'capabilities',
      protocol: 1,
      build: {
        version: '0.5.14',
        commit: 'a'.repeat(40),
        sourceDigest: 'b'.repeat(64),
        target: 'migration-test',
        protocol: 1,
        capabilities: [],
        dirty: true,
      },
    }),
  );
  return { ws, epoch };
}
try {
  await start(false);
  const login = await request('/auth/login', '', { secret, kind: 'cli' });
  const key = await request('/admin/api-keys', login.token, {
    name: 'legacy-agent',
    role: 'agent',
  });
  const identity = await request('/auth/api-key', '', {
    apiKey: key.apiKey,
    role: 'agent',
    name: 'legacy-agent',
  });
  const cli = await request('/admin/api-keys', login.token, {
    name: 'legacy-cli',
    role: 'cli',
    hostId: identity.hostId,
  });
  const first = await connect(key.apiKey);
  agent = first.ws;
  first.ws.close();
  await once(first.ws, 'close');
  await stop();
  await start(true);
  const page = await request('/admin/state/migrate', login.token, {});
  assert.ok(page.ids.includes(identity.hostId));
  const hosts = await request('/hosts', cli.apiKey);
  assert.equal(hosts[0].id, identity.hostId);
  assert.equal(hosts[0].online, false);
  const second = await connect(key.apiKey);
  agent = second.ws;
  assert.ok(
    second.epoch > first.epoch,
    'Migration must never reset Agent fencing',
  );
  await wait(
    async () => (await request('/hosts', cli.apiKey))[0].online,
    'Agent capabilities',
  );
  second.ws.on('message', (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'control')
      second.ws.send(
        JSON.stringify({
          v: 1,
          type: 'result',
          requestId: frame.requestId,
          data: { online: true, confirmedAt: Date.now() },
        }),
      );
  });
  const accepted = await request(
    `/hosts/${identity.hostId}/probe`,
    cli.apiKey,
    {},
  );
  const receiptPath = `/hosts/${identity.hostId}/operations/${accepted.operationId}`;
  await wait(
    async () => (await request(receiptPath, cli.apiKey)).state === 'completed',
    'receipt completion',
  );
  second.ws.close();
  await once(second.ws, 'close');
  await wait(
    async () => !(await request('/hosts', cli.apiKey))[0].online,
    'offline presence',
  );
  await stop();
  await start(true);
  assert.equal(
    (await request(receiptPath, cli.apiKey)).result.online,
    true,
    'Receipt survives disconnect, cleanup and Worker restart',
  );
  await request(receiptPath, cli.apiKey, {});
  console.log(
    'D1 migration passed: legacy credentials, epochs, offline metadata and restart-safe receipts (real Wrangler).',
  );
} catch (error) {
  console.error(logs.replaceAll(secret, '[test-secret]'));
  throw error;
} finally {
  agent?.terminate();
  await stop();
  rmSync(directory, { recursive: true, force: true });
}

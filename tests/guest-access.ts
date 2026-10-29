import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const dir = mkdtempSync(join(tmpdir(), 'coc-guest-'));
const portServer = createServer();
await new Promise<void>((resolve) =>
  portServer.listen(0, '127.0.0.1', resolve),
);
const port = (portServer.address() as { port: number }).port;
await new Promise<void>((resolve) => portServer.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const secret = randomUUID().repeat(2);
const download = `guest-public-${randomUUID()}.txt`;
mkdirSync('dist/web/downloads', { recursive: true });
writeFileSync(join('dist/web/downloads', download), 'public download');
const worker = spawn(
  process.execPath,
  [
    'node_modules/wrangler/bin/wrangler.js',
    'dev',
    '--ip',
    '127.0.0.1',
    '--port',
    String(port),
    '--persist-to',
    join(dir, 'worker'),
    '--var',
    'OWNER_SECRET:' + secret,
    '--var',
    'ACCESS_ENABLED:true',
  ],
  {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  },
);
let logs = '',
  owner = '';
let socket: WebSocket | undefined;
let pendingSocket: WebSocket | undefined;
worker.stdout.on('data', (data) => {
  logs += data;
});
worker.stderr.on('data', (data) => {
  logs += data;
});
async function call(path: string, data?: unknown, cookie = '', admin = false) {
  return fetch(origin + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      Cookie: cookie,
      ...(admin ? { Authorization: 'Bearer ' + owner } : {}),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
}
async function api(path: string, data?: unknown, cookie = '', admin = false) {
  const response = await call('/guest/api/v1' + path, data, cookie, admin);
  const result: any = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return {
    result,
    cookie: response.headers.get('Set-Cookie')?.split(';')[0] || '',
  };
}
try {
  const deadline = Date.now() + 45000;
  while (true) {
    try {
      if ((await call('/guest/api/v1/healthz')).status === 200) break;
    } catch {
      /* The isolated Worker is still starting. */
    }
    if (worker.exitCode !== null || Date.now() > deadline)
      throw new Error('Guest Worker did not start:\n' + logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await call('/api/v1/healthz')).status, 401);
  const entry = await fetch(origin + '/guest?test=1', { redirect: 'manual' });
  assert.equal(entry.status, 307);
  assert.equal(entry.headers.get('Location'), origin + '/guest/?test=1');
  const html = await call('/guest/');
  assert.equal(html.status, 200);
  const script = (await html.text()).match(/<script[^>]+src="([^"]+)"/)![1];
  const scriptUrl = new URL(script, origin + '/guest/');
  assert(scriptUrl.pathname.startsWith('/guest/assets/'));
  assert.equal((await fetch(scriptUrl)).status, 200);
  assert.equal(
    await (await call('/downloads/' + download)).text(),
    'public download',
  );
  assert.deepEqual((await api('/auth/email')).result, { enabled: false });
  owner = (await api('/auth/login', { secret, kind: 'cli' })).result.token;
  const key = (
    await api(
      '/admin/api-keys',
      { name: 'Guest test Agent', role: 'agent' },
      '',
      true,
    )
  ).result;
  const host = (
    await api('/auth/api-key', {
      apiKey: key.apiKey,
      role: 'agent',
      name: 'Guest test Agent',
    })
  ).result;
  const start = await api('/auth/device/start', {
    role: 'web',
    name: 'Guest browser',
    requestedHostId: host.hostId,
  });
  const pendingOptions = {
    headers: { Origin: origin, Cookie: start.cookie },
    closeTimeout: 1000,
  };
  pendingSocket = new WebSocket(
    origin.replace(/^http/, 'ws') +
      '/guest/api/v1/auth/device/events?id=' +
      start.result.id,
    pendingOptions,
  );
  const [, [pendingMessage]] = await Promise.all([
    once(pendingSocket, 'open', { signal: AbortSignal.timeout(15000) }),
    once(pendingSocket, 'message', { signal: AbortSignal.timeout(15000) }),
  ]);
  assert.equal(JSON.parse(pendingMessage.toString()).type, 'subscribed');
  const changed = once(pendingSocket, 'message', {
    signal: AbortSignal.timeout(15000),
  });
  await api('/admin/approve', { id: start.result.id }, '', true);
  assert.equal(JSON.parse((await changed)[0].toString()).type, 'change');
  pendingSocket.terminate();
  const approved = await api(
    '/auth/device/poll',
    { id: start.result.id },
    start.cookie,
  );
  assert.equal(approved.result.state, 'approved');
  assert(approved.cookie.startsWith('coc_guest_web_'));
  const identityPath = '/api/v1/client/identity?hostId=' + host.hostId;
  assert.equal((await call('/guest' + identityPath)).status, 401);
  const identity = (
    await api(
      '/client/identity?hostId=' + host.hostId,
      undefined,
      approved.cookie,
    )
  ).result.identity;
  const socketOptions = {
    headers: { Origin: origin, Cookie: approved.cookie },
    closeTimeout: 1000,
  };
  socket = new WebSocket(
    origin.replace(/^http/, 'ws') + '/guest/ws/v1/hosts/' + host.hostId,
    socketOptions,
  );
  const [, [message]] = await Promise.all([
    once(socket, 'open', { signal: AbortSignal.timeout(15000) }),
    once(socket, 'message', { signal: AbortSignal.timeout(15000) }),
  ]);
  assert.equal(JSON.parse(message.toString()).type, 'subscribed');
  const closed = once(socket, 'close', { signal: AbortSignal.timeout(15000) });
  await api('/admin/revoke', { id: identity }, '', true);
  assert.equal((await closed)[0], 4001);
  assert.equal(
    (await call('/guest' + identityPath, undefined, approved.cookie)).status,
    401,
  );
  console.log(
    'PASS: real Worker guest assets, public downloads, CoC pairing, WebSocket subscription and revocation; root still requires Access',
  );
} finally {
  socket?.terminate();
  pendingSocket?.terminate();
  if (worker.pid && worker.exitCode === null) {
    process.kill(-worker.pid, 'SIGTERM');
    await once(worker, 'exit');
  }
  rmSync(join('dist/web/downloads', download), { force: true });
  rmSync(dir, { recursive: true, force: true });
}

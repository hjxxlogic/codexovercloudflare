import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:https';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
const dir = mkdtempSync(join(tmpdir(), 'coc-access-'));
const save = (name: string, value: unknown) =>
  writeFileSync(join(dir, name), JSON.stringify(value), { mode: 0o600 });
let expectHeaders = true,
  html = false,
  wsCalls = 0,
  reply = false;
const httpPaths: string[] = [];
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    join(dir, 'key.pem'),
    '-out',
    join(dir, 'cert.pem'),
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=DNS:localhost',
    '-days',
    '1',
  ],
  { stdio: 'ignore' },
);
const server = createServer(
  {
    key: readFileSync(join(dir, 'key.pem')),
    cert: readFileSync(join(dir, 'cert.pem')),
  },
  (req, res) => {
    httpPaths.push(req.url!);
    assert.equal(
      req.headers['cf-access-client-id'],
      expectHeaders ? 'native-access-id' : undefined,
    );
    assert.equal(
      req.headers['cf-access-client-secret'],
      expectHeaders ? 'native-access-secret' : undefined,
    );
    res.setHeader('X-CoC-Demand', '1');
    res.setHeader('Content-Type', html ? 'text/html' : 'application/json');
    if (html) {
      res.end('<html>Access login</html>');
      return;
    }
    if (req.url?.endsWith('/attach'))
      res.end(JSON.stringify({ mode: 'cli', ticket: 'native-access-ticket' }));
    else res.end(JSON.stringify([{ id: 'host', name: 'test', online: true }]));
  },
);
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  assert.equal(req.headers['cf-access-client-id'], 'native-access-id');
  assert.equal(req.headers['cf-access-client-secret'], 'native-access-secret');
  if (req.url?.startsWith('/ws/v1/cli/')) {
    wsCalls++;
    assert.equal(req.headers.authorization, 'Bearer native-access-ticket');
    ws.send(JSON.stringify({ test: 'shared-access-bridge' }));
    ws.on('message', (raw) => {
      if (JSON.parse(raw.toString()).test === 'bridge-reply') reply = true;
    });
  }
});
try {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const origin = 'https://localhost:' + (server.address() as any).port;
  save('access.json', {
    origins: [origin],
    clientId: 'native-access-id',
    clientSecret: 'native-access-secret',
  });
  save('client.json', {
    autoUpdate: false,
    version: 2,
    selected: origin + '~host',
    entries: [
      {
        relay: origin,
        hostId: 'host',
        role: 'cli',
        name: 'test',
        token: 'native-coc-key',
      },
    ],
  });
  mkdirSync(join(dir, 'bin'));
  symlinkSync(resolve('tests/fixtures/access-tui.mjs'), join(dir, 'bin/codex'));
  const env = {
    ...process.env,
    SSL_CERT_FILE: join(dir, 'cert.pem'),
    COC_ACCESS_CONFIG: join(dir, 'access.json'),
    COC_CREDENTIALS: join(dir, 'client.json'),
    COC_HISTORY_DIR: join(dir, 'history'),
    PATH: join(dir, 'bin') + ':' + process.env.PATH,
  };
  const run = (args: string[]) =>
    new Promise<{ code: number | null; output: string }>(
      (resolveRun, reject) => {
        const child = spawn(
          resolve(process.env.COC_CLI_BINARY || 'build/coc-client'),
          args,
          { env },
        );
        let output = '';
        child.stdout.on('data', (b) => (output += b));
        child.stderr.on('data', (b) => (output += b));
        child.on('error', reject);
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('Native Access test timed out'));
        }, 15000);
        child.on('close', (code) => {
          clearTimeout(timer);
          resolveRun({ code, output });
        });
      },
    );
  assert.equal((await run(['attach', 'host~session'])).code, 0);
  assert.equal(
    wsCalls,
    1,
    'Access alone enables the local TUI bridge without a network proxy',
  );
  assert.equal(reply, true);
  assert.ok(httpPaths.includes('/api/v1/sessions/host~session/attach'));
  assert.equal((await run(['status'])).code, 0);
  html = true;
  const failed = await run(['status']);
  assert.equal(failed.code, 1);
  assert.ok(failed.output.includes('ACCESS_REQUIRED'));
  assert.ok(!failed.output.includes('native-access-secret'));
  html = false;
  expectHeaders = false;
  save('access.json', {
    origins: ['https://another-relay.test'],
    clientId: 'native-access-id',
    clientSecret: 'native-access-secret',
  });
  assert.equal(
    (await run(['status'])).code,
    0,
    'Unlisted origins receive no shared credentials',
  );
  console.log(
    'PASS: native Access HTTPS, WSS TUI bridge without proxy, origin isolation and HTML rejection',
  );
} finally {
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
}

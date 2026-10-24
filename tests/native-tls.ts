// Exercise actual native HTTPS/WSS clients with a temporary local CA.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
const dir = mkdtempSync(join(tmpdir(), 'coc-tls-'));
const openssl = (args: string[]) =>
  execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
const save = (file: string, data: unknown) =>
  writeFileSync(join(dir, file), JSON.stringify(data), { mode: 0o600 });
try {
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'ca.key',
    '-out',
    'ca.pem',
    '-subj',
    '/CN=coc-test-ca',
    '-days',
    '1',
  ]);
  openssl([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    'leaf.key',
    '-out',
    'leaf.csr',
    '-subj',
    '/CN=localhost',
  ]);
  for (const name of ['localhost', 'wrong.example']) {
    writeFileSync(
      join(dir, 'leaf.ext'),
      `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${name}\n`,
    );
    openssl([
      'x509',
      '-req',
      '-in',
      'leaf.csr',
      '-CA',
      'ca.pem',
      '-CAkey',
      'ca.key',
      '-CAcreateserial',
      '-out',
      name + '.pem',
      '-days',
      '1',
      '-extfile',
      'leaf.ext',
    ]);
  }
  for (const scenario of [
    {
      name: 'trusted certificate',
      cert: 'localhost',
      trusted: true,
      accept: true,
    },
    { name: 'untrusted CA', cert: 'localhost', trusted: false, accept: false },
    {
      name: 'wrong hostname',
      cert: 'wrong.example',
      trusted: true,
      accept: false,
    },
  ]) {
    let httpRequests = 0,
      wsRequests = 0;
    const server = createServer(
      {
        key: readFileSync(join(dir, 'leaf.key')),
        cert: readFileSync(join(dir, scenario.cert + '.pem')),
      },
      (req, res) => {
        httpRequests++;
        assert.equal(req.headers.authorization, 'Bearer local-test-owner');
        res.setHeader('Content-Type', 'application/json');
        res.end('[]');
      },
    );
    const wss = new WebSocketServer({ server });
    let resolveProjects!: () => void;
    const projects = new Promise<void>((r) => (resolveProjects = r));
    wss.on('connection', (ws, req) => {
      wsRequests++;
      assert.equal(
        req.headers.authorization,
        'Bearer local-device-token-placeholder',
      );
      ws.send(JSON.stringify({ type: 'hello', epoch: 1 }));
      ws.send(
        JSON.stringify({
          type: 'control',
          requestId: 'tls-test',
          action: 'projects',
          data: {},
        }),
      );
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.type === 'result') {
          assert.equal(m.data[0].id, 'test');
          resolveProjects();
        }
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const origin = 'https://localhost:' + (server.address() as any).port;
    const env = {
      ...process.env,
      SSL_CERT_FILE: scenario.trusted ? join(dir, 'ca.pem') : '/dev/null',
      SSL_CERT_DIR: dir,
      COC_CREDENTIALS: join(dir, 'credentials.json'),
    };
    save('credentials.json', {
      version: 2,
      selected: origin + '~tls-host',
      entries: [
        {
          relay: origin,
          hostId: 'tls-host',
          name: 'tls',
          role: 'cli',
          token: 'local-test-owner',
        },
      ],
    });
    const cli = spawn(
      resolve(process.env.COC_CLI_BINARY || 'build/coc-client'),
      ['status'],
      { env, stdio: 'ignore' },
    );
    assert.equal(
      await new Promise<number | null>((r) => cli.once('exit', r)),
      scenario.accept ? 0 : 1,
      scenario.name + ': HTTPS',
    );
    save('agent.json', {
      relayUrl: origin,
      hostId: 'tls-host',
      token: 'local-device-token-placeholder',
      dataDir: join(dir, 'state-' + scenario.cert + scenario.trusted),
      codexPath: process.execPath,
      codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
      projects: [{ id: 'test', name: 'Test', path: dir }],
    });
    const agent = spawn(
      resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent'),
      ['run', '--config', join(dir, 'agent.json')],
      { env, stdio: 'ignore' },
    );
    try {
      if (scenario.accept) {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            projects,
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('WSS did not connect')),
                10000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
        assert.equal(httpRequests, 1);
        assert.equal(wsRequests, 1);
      } else {
        await new Promise((r) => setTimeout(r, 1800));
        assert.equal(httpRequests, 0);
        assert.equal(wsRequests, 0);
      }
      console.log('PASS: native HTTPS + WSS ' + scenario.name);
    } finally {
      await new Promise<void>((r) => {
        agent.once('exit', () => r());
        agent.kill('SIGTERM');
      });
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

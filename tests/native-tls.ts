// Exercise actual native HTTPS/WSS clients with a temporary local CA.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createServer as createProxy } from 'node:http';
import { connect } from 'node:net';
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
      `basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${name}${name === 'localhost' ? ',IP:203.0.113.10' : ''}\n`,
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
  ])
    for (const proxied of [false, true]) {
      let httpRequests = 0,
        approvalRequests = 0,
        wsRequests = 0;
      let resolveApprovals!: () => void;
      const approvals = new Promise<void>((r) => (resolveApprovals = r));
      const server = createServer(
        {
          key: readFileSync(join(dir, 'leaf.key')),
          cert: readFileSync(join(dir, scenario.cert + '.pem')),
        },
        (req, res) => {
          if (req.url === '/api/v1/agent/requests') {
            approvalRequests++;
            assert.equal(req.method, 'GET');
            assert.equal(
              req.headers.authorization,
              'Bearer local-device-token-placeholder',
            );
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('X-CoC-Demand', '1');
            res.end(JSON.stringify({ hostId: 'tls-host', pending: [] }));
            resolveApprovals();
            return;
          }
          httpRequests++;
          assert.equal(req.url, '/api/v1/hosts');
          assert.equal(req.headers.authorization, 'Bearer local-test-owner');
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('X-CoC-Demand', '1');
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
        ws.send(JSON.stringify({ type: 'hello', demand: 1, epoch: 1 }));
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
      let tunnels = 0;
      const proxy = createProxy();
      proxy.on('connect', (request, client, head) => {
        assert.equal(
          request.url,
          '203.0.113.10:' + (server.address() as any).port,
        );
        assert.equal(request.headers.authorization, undefined);
        tunnels++;
        const upstream = connect(
          (server.address() as any).port,
          '127.0.0.1',
          () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            client.pipe(upstream);
            upstream.pipe(client);
          },
        );
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
        upstream.on('close', () => client.destroy());
      });
      await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
      const proxyUrl = 'http://127.0.0.1:' + (proxy.address() as any).port;
      const origin =
        'https://' +
        (proxied ? '203.0.113.10' : 'localhost') +
        ':' +
        (server.address() as any).port;
      const env = {
        ...process.env,
        SSL_CERT_FILE: scenario.trusted ? join(dir, 'ca.pem') : '/dev/null',
        SSL_CERT_DIR: dir,
        COC_CREDENTIALS: join(dir, 'credentials.json'),
      };
      save('credentials.json', {
        autoUpdate: false,
        proxy: proxyUrl,
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
        proxy: proxyUrl,
        hostId: 'tls-host',
        token: 'local-device-token-placeholder',
        dataDir: join(dir, 'state-' + scenario.cert + scenario.trusted),
        autoUpdate: false,
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
              Promise.all([projects, approvals]),
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
          assert.equal(approvalRequests, 1);
          assert.equal(wsRequests, 1);
        } else {
          await new Promise((r) => setTimeout(r, 1800));
          assert.equal(httpRequests, 0);
          assert.equal(approvalRequests, 0);
          assert.equal(wsRequests, 0);
        }
        assert.equal(proxied ? tunnels >= 2 : tunnels === 0, true);
        console.log(
          'PASS: native HTTPS + WSS ' +
            scenario.name +
            (proxied ? ' via HTTP CONNECT' : ' bypasses proxy for loopback'),
        );
      } finally {
        await new Promise<void>((r) => {
          agent.once('exit', () => r());
          agent.kill('SIGTERM');
        });
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        await new Promise<void>((r) => server.close(() => r()));
        await new Promise<void>((r) => proxy.close(() => r()));
      }
    }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

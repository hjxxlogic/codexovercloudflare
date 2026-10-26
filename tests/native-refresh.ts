import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { WebSocketServer } from 'ws';
const dir = mkdtempSync(join(tmpdir(), 'coc-refresh-'));
const reads: number[] = [];
let started = 0,
  mutations = 0;
const server = createServer((req, res) => {
  const send = (value: unknown, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'X-CoC-Demand': '1',
    });
    res.end(JSON.stringify(value));
  };
  if (req.url === '/api/v1/hosts') return send([{ id: 'host', online: true }]);
  if (req.url === '/api/v1/hosts/host/probe')
    return send({ online: true, confirmedAt: Date.now() });
  if (req.url === '/api/v1/hosts/host/projects') {
    mutations++;
    started = Date.now();
    assert.equal(req.headers['x-coc-async'], '1');
    return send(
      { accepted: true, operationId: 'receipt', hostId: 'host' },
      202,
    );
  }
  if (req.url === '/api/v1/hosts/host/operations/receipt') {
    if (req.method === 'POST') return send({ ok: true });
    reads.push(Date.now());
    return send(
      Date.now() - started >= 19000
        ? { state: 'completed', result: [{ id: 'project' }] }
        : { state: 'pending' },
    );
  }
  send({ error: { code: 'NOT_FOUND', message: 'Unknown test route' } }, 404);
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (ws) =>
  ws.send(JSON.stringify({ type: 'subscribed', revision: 0, demand: 1 })),
);
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const relay = `http://127.0.0.1:${(server.address() as any).port}`;
const file = join(dir, 'client.json');
writeFileSync(
  file,
  JSON.stringify({
    version: 2,
    autoUpdate: false,
    selected: relay + '~host',
    entries: [
      {
        relay,
        role: 'cli',
        hostId: 'host',
        name: 'test',
        token: 'local-test-refresh-credential',
      },
    ],
  }),
  { mode: 0o600 },
);
const child = spawn(
  resolve(process.env.COC_CLI_BINARY || 'build/coc-client'),
  ['projects', '--config', file],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let output = '',
  errors = '';
child.stdout.on('data', (value) => {
  output += value;
});
child.stderr.on('data', (value) => {
  errors += value;
});
const timeout = setTimeout(() => child.kill('SIGKILL'), 35000);
try {
  const exit = await new Promise((done) => child.once('exit', done));
  assert.equal(exit, 0, errors);
  assert.equal(JSON.parse(output)[0].id, 'project');
  assert.equal(mutations, 1);
  const rounds = reads.filter((at, i) => !i || at - reads[i - 1] > 1000);
  assert.equal(rounds.length, 3, JSON.stringify(reads));
  for (let i = 1; i < rounds.length; i++)
    assert(rounds[i] - rounds[i - 1] >= 9900, JSON.stringify(reads));
  const finished = reads.length;
  await new Promise((done) => setTimeout(done, 10500));
  assert.equal(
    reads.length,
    finished,
    'client must stop refresh after command completes',
  );
  console.log(
    JSON.stringify({
      scenario: 'A-CC',
      rounds: rounds.length,
      gapsMs: rounds.slice(1).map((at, i) => at - rounds[i]),
      submissions: mutations,
      stoppedAfterExit: true,
    }),
  );
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null) child.kill('SIGKILL');
  for (const ws of sockets.clients) ws.terminate();
  await new Promise<void>((done) =>
    sockets.close(() => server.close(() => done())),
  );
  rmSync(dir, { recursive: true, force: true });
}

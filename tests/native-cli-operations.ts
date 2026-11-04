import { encryptedFixture } from './helpers/encrypted-fixture.ts';
// Real CLI journal and HTTP transport; the simulated relay may lose all correlations.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';

const root = mkdtempSync(join(tmpdir(), 'coc-cli-operations-'));
const config = join(root, 'client.json');
const children = new Set<ChildProcess>();
const receipts = new Map<string, any>();
const originals = new Map<
  string,
  { path: string; body: unknown; result: unknown }
>();
const submissions: { id: string; instance: string; ack: boolean }[] = [];
let database: DatabaseSync | undefined;
let instance = 'original-agent-store';
let mode = 'recover';
let ackLoss = true;
let probes = 0;
let effects = 0;
let error: unknown;
const owner = 'a'.repeat(64);
const local = (id: string) => {
  database ??= new DatabaseSync(
    join(root, 'history', 'transport-v3', 'agent.db'),
  );
  const row = database
    .prepare(
      "SELECT value FROM transport2_local_operations WHERE json_extract(value,'$.requestId')=?",
    )
    .get(id);
  return row ? JSON.parse(String(row.value)) : undefined;
};
const server = createServer(async (request, response) => {
  const send = (body: unknown, status = 200) =>
    response
      .writeHead(status, {
        'Content-Type': 'application/json',
        'X-CoC-Demand': '1',
        'X-CoC-Delivery': '2',
      })
      .end(JSON.stringify(body));
  try {
    if (request.url === '/api/v1/hosts/host/probe') {
      probes++;
      return send({
        online: true,
        deliveryInstance: instance,
        operationInstance: instance,
      });
    }
    if (request.url === '/api/v1/hosts')
      return send([{ id: 'host', online: true }]);
    if (request.url?.startsWith('/api/v1/hosts/host/operations/')) {
      const id = request.url.split('/').at(-1)!;
      if (request.method === 'POST') {
        const receipt = receipts.get(id);
        if (receipt?.intent) {
          const record = local(receipt.intent.requestId);
          assert.equal(
            record.state,
            receipt.intent.ack ? 'confirmed' : 'completed',
            'C commit precedes forwarding-result deletion',
          );
        }
        receipts.delete(id);
        return send({ ok: true });
      }
      if (!receipts.has(id))
        return send(
          { error: { code: 'RESULT_UNKNOWN', message: 'Correlation lost' } },
          409,
        );
      return send(receipts.get(id));
    }
    if (request.url !== '/api/v1/sessions/host~session/stop')
      return send(
        { error: { code: 'NOT_FOUND', message: 'Unknown test route' } },
        404,
      );
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const id = String(request.headers['idempotency-key']);
    const expected = String(request.headers['x-coc-operation-instance']);
    const ack = request.headers['x-coc-operation-ack'] === '1';
    submissions.push({ id, instance: expected, ack });
    const record = local(id);
    assert(
      record,
      'An original intention exists durably before its first wire request',
    );
    assert.equal(record.instance, expected);
    assert.equal(record.path, '/sessions/host~session/stop');
    assert.deepEqual(record.body, body);
    if (ack) {
      assert.equal(record.state, 'completed');
      assert(
        record.result,
        'The complete local result commits before A confirmation',
      );
      if (ackLoss) {
        ackLoss = false;
        return send(
          {
            error: {
              code: 'HTTP_NETWORK',
              message: 'Simulated confirmation loss',
            },
          },
          503,
        );
      }
    } else assert(['pending', 'completed'].includes(record.state));
    const wire = 'delivery_' + randomUUID();
    const proof = {
      requestId: id,
      instance: expected,
      owner,
      ...(ack ? { ack: true } : {}),
    };
    if (expected !== instance)
      receipts.set(wire, {
        state: 'completed',
        error: { code: 'DELIVERY_STATE_MISMATCH', message: 'Store replaced' },
      });
    else if (ack)
      receipts.set(wire, {
        state: 'completed',
        result: { confirmed: true },
        intent: proof,
      });
    else {
      if (!originals.has(id)) {
        effects++;
        originals.set(id, {
          path: request.url,
          body,
          result: { id: 'host~session', original: id, state: 'closing' },
        });
      }
      if (mode === 'result-storage') {
        database!.exec(
          "CREATE TRIGGER fail_local_result BEFORE UPDATE OF value ON transport2_local_operations BEGIN SELECT RAISE(ABORT,'test result storage failure'); END",
        );
        receipts.set(wire, {
          state: 'completed',
          result: originals.get(id)!.result,
          intent: proof,
        });
      } else if (mode === 'hold') receipts.set(wire, { state: 'pending' });
      else if (mode === 'unknown')
        receipts.set(wire, {
          state: 'completed',
          error: {
            code: 'RESULT_UNKNOWN',
            message: 'Execution ended without a known outcome',
          },
          intent: proof,
        });
      else if (mode === 'bad-proof')
        receipts.set(wire, {
          state: 'completed',
          result: originals.get(id)!.result,
          intent: { ...proof, instance: 'wrong-store' },
        });
      else if (mode === 'missing-proof')
        receipts.set(wire, {
          state: 'completed',
          result: originals.get(id)!.result,
        });
      else if (
        mode !== 'recover' ||
        submissions.filter((s) => s.id === id && !s.ack).length > 1
      )
        receipts.set(wire, {
          state: 'completed',
          result: originals.get(id)!.result,
          intent: proof,
        });
      // recover deliberately loses the first forwarding correlation after A executes.
    }
    return send({ accepted: true, hostId: 'host', operationId: wire }, 202);
  } catch (failure) {
    error = failure;
    return send(
      { error: { code: 'TEST_FAILURE', message: String(failure) } },
      500,
    );
  }
});
const sockets = new WebSocketServer({ server });
sockets.on('connection', (socket, request) => {
  if (encryptedFixture(socket, request)) return;
  socket.send(JSON.stringify({ type: 'subscribed', revision: 0, demand: 1 }));
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const relay = `http://127.0.0.1:${(server.address() as any).port}`;
writeFileSync(
  config,
  JSON.stringify({
    version: 2,
    autoUpdate: false,
    selected: relay + '~host',
    entries: [
      {
        relay,
        hostId: 'host',
        token: 'local-cli-operation-credential',
        name: 'test',
      },
    ],
  }),
  { mode: 0o600 },
);
function launch(args: string[]) {
  const child = spawn(
    resolve(process.env.COC_CLI_BINARY || 'build/coc-client'),
    [...args, '--config', config],
    {
      env: { ...process.env, COC_HISTORY_DIR: join(root, 'history') },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (data) => (stdout += data));
  child.stderr.on('data', (data) => (stderr += data));
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  const done = new Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>((done) =>
    child.once('close', (code) => {
      clearTimeout(timeout);
      children.delete(child);
      done({ code, stdout, stderr });
    }),
  );
  return { child, done };
}
async function run(args: string[], expected = 0) {
  const result = await launch(args).done;
  if (error) throw error;
  assert.equal(result.code, expected, result.stderr);
  return result;
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!predicate()) {
    if (error) throw error;
    assert(Date.now() < deadline, 'Timed out waiting for CLI wire request');
    await new Promise((done) => setTimeout(done, 20));
  }
}
try {
  const recovered = launch(['stop', 'host~session', '--request-id', 'recover']);
  await until(() => !ackLoss);
  recovered.child.kill('SIGKILL');
  await recovered.done;
  assert.equal(effects, 1);
  assert.equal(
    new Set(
      submissions.filter((s) => s.id === 'recover').map((s) => s.instance),
    ).size,
    1,
  );
  assert.equal(
    local('recover').state,
    'completed',
    'Lost confirmation preserves the fixed input and complete result',
  );
  const beforeQueries = probes;
  const queried = await run(['request', 'recover']);
  assert.equal(JSON.parse(queried.stdout).result.original, 'recover');
  assert.equal(local('recover').state, 'confirmed');
  assert.equal(local('recover').body, undefined);
  assert.equal(
    probes,
    beforeQueries,
    'Recovery does not rediscover and rebind the original Agent instance',
  );
  assert.equal(effects, 1);
  const beforeCached = submissions.length;
  await run(['request', 'recover']);
  assert.equal(
    submissions.length,
    beforeCached,
    'Confirmed local results need no idle network work',
  );

  mode = 'hold';
  const interrupted = launch([
    'stop',
    'host~session',
    '--request-id',
    'interrupted',
  ]);
  await until(() => submissions.some((s) => s.id === 'interrupted'));
  interrupted.child.kill('SIGKILL');
  await interrupted.done;
  assert.equal(local('interrupted').state, 'pending');
  const beforeResume = effects;
  mode = 'ready';
  const resumed = await run(['request', 'interrupted']);
  assert.equal(JSON.parse(resumed.stdout).result.original, 'interrupted');
  assert.equal(
    effects,
    beforeResume,
    'Restarted C queries the same A intention without executing it anew',
  );

  mode = 'hold';
  const replaced = launch(['stop', 'host~session', '--request-id', 'replaced']);
  await until(() => submissions.some((s) => s.id === 'replaced'));
  replaced.child.kill('SIGKILL');
  await replaced.done;
  instance = 'replacement-agent-store';
  mode = 'ready';
  const mismatch = await run(['request', 'replaced'], 1);
  assert.match(mismatch.stderr, /DELIVERY_STATE_MISMATCH/);
  assert.equal(local('replaced').instance, 'original-agent-store');
  assert.equal(local('replaced').state, 'pending');
  assert.equal(submissions.filter((s) => s.id === 'replaced').length, 2);

  mode = 'unknown';
  const uncertain = await run(
    ['stop', 'host~session', '--request-id', 'uncertain'],
    1,
  );
  assert.match(uncertain.stderr, /RESULT_UNKNOWN/);
  assert.equal(local('uncertain').state, 'confirmed');
  const beforeUnknown = submissions.length;
  assert.equal(
    JSON.parse((await run(['request', 'uncertain'])).stdout).error.code,
    'RESULT_UNKNOWN',
  );
  assert.equal(
    submissions.length,
    beforeUnknown,
    'Durable business uncertainty stops automatic execution',
  );

  mode = 'bad-proof';
  await run(['stop', 'host~session', '--request-id', 'bad-proof'], 1);
  assert.equal(local('bad-proof').state, 'pending');
  assert(!submissions.some((s) => s.id === 'bad-proof' && s.ack));
  mode = 'missing-proof';
  const missing = launch([
    'stop',
    'host~session',
    '--request-id',
    'missing-proof',
  ]);
  await until(
    () => submissions.filter((s) => s.id === 'missing-proof').length >= 2,
  );
  missing.child.kill('SIGKILL');
  await missing.done;
  assert.equal(local('missing-proof').state, 'pending');
  assert.equal(local('missing-proof').result, undefined);
  assert(!submissions.some((s) => s.id === 'missing-proof' && s.ack));

  mode = 'result-storage';
  const beforeFailedResult = effects;
  await run(['stop', 'host~session', '--request-id', 'result-storage'], 1);
  assert.equal(local('result-storage').state, 'pending');
  assert.equal(local('result-storage').result, undefined);
  assert(!submissions.some((s) => s.id === 'result-storage' && s.ack));
  database!.exec('DROP TRIGGER fail_local_result');
  mode = 'ready';
  await run(['request', 'result-storage']);
  assert.equal(
    effects,
    beforeFailedResult + 1,
    'Failed result commit is recovered from the same original execution',
  );

  database!.exec(
    "CREATE TRIGGER fail_local_intent BEFORE INSERT ON transport2_local_operations BEGIN SELECT RAISE(ABORT,'test storage failure'); END",
  );
  mode = 'ready';
  const beforeStorage = submissions.length;
  await run(['stop', 'host~session', '--request-id', 'storage-failure'], 1);
  assert.equal(
    submissions.length,
    beforeStorage,
    'Failed local commit prevents the first business wire request',
  );
  assert.equal(local('storage-failure'), undefined);
  database!.exec('DROP TRIGGER fail_local_intent');
  if (error) throw error;
  console.log(
    'PASS: real CLI durable first wire, original recovery, lost confirmation, restart, instance fencing, proof validation, durable uncertainty and storage failure',
  );
} finally {
  for (const child of children) child.kill('SIGKILL');
  database?.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise<void>((done) =>
    sockets.close(() => server.close(() => done())),
  );
  rmSync(root, { recursive: true, force: true });
}

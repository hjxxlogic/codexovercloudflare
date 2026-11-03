import { resolveAsync } from '../tests/helpers/async-http.ts';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { join, resolve, delimiter } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { OriginalHttpRequests } from '../tests/helpers/original-http.ts';
import { Agent } from '../tests/support/native-agent.ts';

// Run the same local Wrangler as the end-to-end suite, with isolated state.
export async function localRelay(dir: string) {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  const origin = `http://127.0.0.1:${port}`,
    secret = randomBytes(32).toString('hex');
  const child = spawn(
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
      'ACCESS_ENABLED:false',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '',
    agent: Agent | undefined,
    token = '';
  let cli: ChildProcess | undefined;
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const close = async () => {
    if (cli?.pid && cli.exitCode === null && cli.signalCode === null) {
      const exited = new Promise<void>((done) =>
        cli!.once('exit', () => done()),
      );
      process.kill(-cli.pid, 'SIGTERM');
      await exited;
    }
    if (agent && !agent.stopped) await agent.close();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGTERM');
      await exited;
    }
  };
  try {
    const end = Date.now() + 45000;
    let ready = false;
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error('Local relay exited');
      try {
        ready = (
          await fetch(origin + '/api/v1/healthz', {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        /* Starting. */
      }
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!ready) throw new Error('Relay startup timed out');
    const originals = new OriginalHttpRequests();
    const api = async (path: string, data?: unknown): Promise<any> => {
      const headers = {
        Origin: origin,
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
        'Idempotency-Key': crypto.randomUUID(),
        'X-CoC-Async': '1',
        'X-CoC-Delivery': '2',
        'X-CoC-Demand': '1',
      };
      await originals.prepare(path, data, headers, (probe) => api(probe, {}));
      const response = await fetch(origin + '/api/v1' + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers,
        body: data === undefined ? undefined : JSON.stringify(data),
      });
      const r = await resolveAsync(response, origin, headers);
      const b: any = await r.json();
      if (!r.ok) throw new Error(b.error?.code + ': ' + b.error?.message);
      return b;
    };
    token = (await api('/auth/login', { secret, kind: 'cli' })).token;
    const authorize = async (role: string, hostId?: string) => {
      const request = await api('/auth/device/start', {
        role,
        name: 'native-smoke',
        hostId,
      });
      await api('/admin/approve', { id: request.id, hostId });
      return api('/auth/device/poll', {
        id: request.id,
        pollSecret: request.pollSecret,
      });
    };
    const device = await authorize('agent');
    const client = await authorize('cli', device.hostId);
    token = client.token;
    agent = new Agent({
      relayUrl: origin,
      hostId: device.hostId,
      token: device.token,
      codexPath: 'codex',
      codexArgs: [],
      codexProxyMode: 'direct',
      sandbox: 'read-only',
      dataDir: dir + '/agent',
      projects: [{ id: 'smoke', name: 'Smoke', path: dir }],
    });
    agent.start();
    const onlineDeadline = Date.now() + 15000;
    while (!(await api('/hosts'))[0].online) {
      if (Date.now() > onlineDeadline) throw new Error('Agent did not connect');
      await new Promise((r) => setTimeout(r, 100));
    }
    const session = await api('/sessions', {
      hostId: device.hostId,
      projectId: 'smoke',
      mode: 'cli',
    });
    // Let the production C++ client own delivery, persistence and the bridge.
    // A temporary launcher exposes its loopback endpoint to the observed real TUI.
    const bin = join(dir, 'bin'),
      endpointFile = join(dir, 'bridge.json');
    mkdirSync(bin);
    const version = execFileSync('codex', ['--version'], {
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(bin, 'codex'),
      `#!${process.execPath}
import {writeFileSync} from 'node:fs';
if(process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); }
else {
 writeFileSync(${JSON.stringify(endpointFile)},JSON.stringify({endpoint:process.argv[process.argv.indexOf('--remote')+1],ticket:process.env.COC_REMOTE_TICKET}),{mode:0o600});
 setInterval(()=>{},1000);
}
`,
      { mode: 0o700 },
    );
    const config = join(dir, 'client.json');
    writeFileSync(
      config,
      JSON.stringify({
        version: 2,
        autoUpdate: false,
        selected: origin + '~' + device.hostId,
        entries: [
          { relay: origin, hostId: device.hostId, token, name: 'native-smoke' },
        ],
      }),
      { mode: 0o600 },
    );
    cli = spawn(
      resolve(process.env.COC_CLI_BINARY || 'build/coc-client'),
      ['attach', session.id, '--config', config, '--proxy', ''],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          PATH: bin + delimiter + process.env.PATH,
          COC_HISTORY_DIR: join(dir, 'client-history'),
        },
      },
    );
    cli.stdout!.on('data', (d) => (logs += d));
    cli.stderr!.on('data', (d) => (logs += d));
    const bridgeDeadline = Date.now() + 15000;
    while (!existsSync(endpointFile)) {
      if (cli.exitCode !== null || Date.now() > bridgeDeadline)
        throw new Error('Native bridge did not start');
      await new Promise((done) => setTimeout(done, 50));
    }
    const bridge = JSON.parse(readFileSync(endpointFile, 'utf8'));
    return { endpoint: bridge.endpoint, ticket: bridge.ticket, close };
  } catch (e) {
    console.error(logs.replaceAll(secret, '[test-secret]'));
    await close();
    throw e;
  }
}

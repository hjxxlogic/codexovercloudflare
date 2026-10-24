import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Agent } from '../tests/support/native-agent.ts';

// Full relay smoke uses a local Bookworm container only for workerd. Agent and
// Codex run on the host with the same configuration as normal usage.
export async function localRelay(dir: string) {
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  await new Promise<void>((r) => server.close(() => r()));
  const origin = `http://127.0.0.1:${port}`,
    secret = randomBytes(32).toString('hex'),
    name = 'coc-native-smoke-' + process.pid;
  const child = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--init',
      '--name',
      name,
      '--network',
      'host',
      '-v',
      process.cwd() + ':/workspace',
      'coc-local-test',
      'node',
      'node_modules/wrangler/bin/wrangler.js',
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--persist-to',
      '/tmp/state',
      '--var',
      'OWNER_SECRET:' + secret,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let logs = '',
    agent: Agent | undefined,
    token = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const close = async () => {
    if (agent && !agent.stopped) await agent.close();
    try {
      execFileSync('docker', ['stop', '--time', '2', name], {
        stdio: 'ignore',
      });
    } catch {
      /* Container already stopped. */
    }
  };
  try {
    const end = Date.now() + 45000;
    let ready = false;
    while (Date.now() < end) {
      if (child.exitCode !== null) throw new Error('Relay container exited');
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
    const api = async (path: string, data?: unknown): Promise<any> => {
      const r = await fetch(origin + '/api/v1' + path, {
        method: data === undefined ? 'GET' : 'POST',
        headers: {
          Origin: origin,
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + token,
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: data === undefined ? undefined : JSON.stringify(data),
      });
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
      await api('/admin/approve', { id: request.id });
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
      }),
      ticket = await api(`/sessions/${session.id}/attach`, {});
    return {
      endpoint: origin.replace('http', 'ws') + '/ws/v1/cli/' + session.id,
      ticket: ticket.ticket,
      close,
    };
  } catch (e) {
    console.error(logs.replaceAll(secret, '[test-secret]'));
    await close();
    throw e;
  }
}

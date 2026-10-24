import { parseArgs } from 'node:util';
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  unlinkSync,
} from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { relayUrl, wsUrl } from '../../../packages/protocol/src/index.ts';

type Credentials = { relay: string; token: string; expires: number };
function save(path: string, data: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
}
async function secret(prompt: string) {
  process.stdout.write(prompt);
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const rl = createInterface({
    input: process.stdin,
    output: sink,
    terminal: !!process.stdin.isTTY,
  });
  try {
    return (await rl.question('')).trim();
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}
async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      relay: { type: 'string' },
      host: { type: 'string' },
      project: { type: 'string' },
      'project-id': { type: 'string' },
      config: { type: 'string' },
      takeover: { type: 'boolean' },
    },
  });
  const [command, id] = positionals;
  const credsPath =
    process.env.COC_CREDENTIALS ||
    join(homedir(), '.config/coc/credentials.json');
  const load = (): Credentials => {
    if (!existsSync(credsPath))
      throw new Error('Login first: npm run coc -- login');
    return JSON.parse(readFileSync(credsPath, 'utf8'));
  };
  async function api(
    path: string,
    body?: unknown,
    anonymous = false,
  ): Promise<any> {
    const c = anonymous
      ? { relay: relayUrl(values.relay || 'https://r.xlogic.cc'), token: '' }
      : load();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Origin: c.relay,
    };
    if (c.token) headers.Authorization = 'Bearer ' + c.token;
    if (body) headers['Idempotency-Key'] = randomUUID();
    const r = await fetch(c.relay + '/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: any = await r.json();
    if (!r.ok) throw new Error(`${data.error?.code}: ${data.error?.message}`);
    return data;
  }
  async function host() {
    const hosts = await api('/hosts');
    const h = hosts.find(
      (h: any) => h.id === values.host || h.name === values.host,
    );
    if (!h) throw new Error('Select a known host with --host');
    return h;
  }
  async function attach(sessionId: string) {
    const c = load();
    const t = await api(
      `/sessions/${sessionId}/${values.takeover ? 'takeover' : 'attach'}`,
      {},
    );
    if (t.mode !== 'cli') throw new Error('Use the browser for a web session');
    console.log(`Remote session: ${sessionId}`);
    const child = spawn(
      'codex',
      [
        '--remote',
        wsUrl(c.relay, '/ws/v1/cli/' + sessionId),
        '--remote-auth-token-env',
        'COC_REMOTE_TICKET',
        '--sandbox',
        t.sandbox || 'workspace-write',
        '--ask-for-approval',
        'on-request',
      ],
      {
        stdio: 'inherit',
        env: { ...process.env, COC_REMOTE_TICKET: t.ticket },
      },
    );
    await new Promise<void>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code) reject(new Error('Codex TUI exited with code ' + code));
        else resolve();
      });
    });
  }
  if (command === 'login') {
    const relay = relayUrl(values.relay || 'https://r.xlogic.cc');
    const data = await api(
      '/auth/login',
      { secret: await secret('Owner secret: '), kind: 'cli' },
      true,
    );
    save(credsPath, { relay, ...data });
    console.log('Logged in to ' + relay);
    return;
  }
  if (command === 'logout') {
    await api('/auth/logout', {});
    unlinkSync(credsPath);
    console.log('Logged out');
    return;
  }
  if (command === 'agent-enroll') {
    if (!values.config || !values.project)
      throw new Error(
        'agent-enroll --config <path> --project <remote-directory> [--project-id name]',
      );
    if (existsSync(values.config))
      throw new Error('Config already exists; refusing to overwrite');
    const data = await api(
      '/agent/enroll',
      { code: await secret('Enrollment code: ') },
      true,
    );
    save(resolve(values.config), {
      relayUrl: relayUrl(values.relay || 'https://r.xlogic.cc'),
      hostId: data.hostId,
      token: data.token,
      codexPath: 'codex',
      codexArgs: [],
      sandbox: 'workspace-write',
      dataDir: join(dirname(resolve(values.config)), 'data'),
      projects: [
        {
          id: values['project-id'] || 'my-project',
          name: values['project-id'] || 'my-project',
          path: resolve(values.project),
        },
      ],
    });
    console.log('Agent config written to ' + resolve(values.config));
    return;
  }
  if (command === 'enroll') {
    if (!id) throw new Error('enroll <host-name>');
    console.log(
      JSON.stringify(await api('/hosts/enrollments', { name: id }), null, 2),
    );
    return;
  }
  if (command === 'hosts') {
    console.table(await api('/hosts'));
    return;
  }
  if (command === 'projects') {
    const h = await host();
    console.table(await api(`/hosts/${h.id}/projects`));
    return;
  }
  if (command === 'sessions') {
    const h = await host();
    console.table(await api('/sessions?hostId=' + h.id));
    return;
  }
  if (command === 'connect') {
    const h = await host();
    if (!values.project) throw new Error('Select --project <project-id>');
    const s = await api('/sessions', {
      hostId: h.id,
      projectId: values.project,
      mode: 'cli',
    });
    await attach(s.id);
    return;
  }
  if (command === 'attach') {
    if (!id) throw new Error('attach <session-id>');
    await attach(id);
    return;
  }
  if (command === 'stop') {
    if (!id) throw new Error('stop <session-id>');
    console.log(await api(`/sessions/${id}/stop`, {}));
    return;
  }
  if (command === 'revoke') {
    const h = await host();
    console.log(await api(`/hosts/${h.id}/revoke`, {}));
    return;
  }
  console.log(
    'Usage: npm run coc -- <login|logout|hosts|enroll|agent-enroll|projects|sessions|connect|attach|stop|revoke> [options]\nDefault relay: https://r.xlogic.cc',
  );
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});

import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  statSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { EndpointPeer, endpointFetch } from './helpers/endpoint-peer.ts';
import { WindowPeer } from './helpers/window-peer.ts';
const { values: options } = parseArgs({
  options: {
    'online-r2': { type: 'boolean' },
    agent: { type: 'string' },
    'owner-secret-file': { type: 'string' },
    'access-config': { type: 'string' },
  },
});
const online = !!options['online-r2'];
if (online && (!options.agent || !options['owner-secret-file']))
  throw new Error(
    'r2 requires a verified CI Agent and a private independent owner secret',
  );
const root = mkdtempSync(join(tmpdir(), 'coc-opaque-'));
function privateFile(path: string) {
  const state = statSync(path);
  if (state.mode & 0o077 || state.uid !== process.getuid!())
    throw new Error(
      'Credential file must be private and owned by the current user',
    );
  return readFileSync(path, 'utf8');
}
const secret = online
  ? privateFile(options['owner-secret-file']!).trim()
  : randomUUID() + randomUUID();
const admission: Record<string, string> = {};
let accessConfig: any;
if (options['access-config']) {
  accessConfig = JSON.parse(privateFile(options['access-config']));
  assert(accessConfig.origins.includes('https://r2.xlogic.cc'));
  admission['CF-Access-Client-Id'] = accessConfig.clientId;
  admission['CF-Access-Client-Secret'] = accessConfig.clientSecret;
}
const report: {
  target: string;
  passed: boolean;
  checks: string[];
  error?: string;
} = {
  target: online ? 'https://r2.xlogic.cc' : 'local',
  passed: false,
  checks: [],
};
const children: ChildProcess[] = [],
  peers: EndpointPeer[] = [];
let logs = '';
const probe = createServer();
await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
const port = (probe.address() as any).port;
await new Promise<void>((r) => probe.close(() => r()));
const origin = online ? 'https://r2.xlogic.cc' : `http://127.0.0.1:${port}`;
function start(binary: string, args: string[], env = process.env) {
  const p = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(p);
  p.stdout!.on('data', (d) => (logs += d));
  p.stderr!.on('data', (d) => (logs += d));
  return p;
}
async function wait(fn: () => any, label: string, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try {
      if (await fn()) return;
    } catch {
      /* boot / async transition */
    }
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timeout: ' + label);
}
let owner = '',
  host = '',
  cli = '',
  cookie = '';
async function control(
  path: string,
  data?: any,
  headers: Record<string, string> = {},
) {
  const r = await fetch(origin + '/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      ...admission,
      ...headers,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const b: any = await r.json();
  assert(r.ok, JSON.stringify(b));
  return { b, r };
}
const ownerHeaders = () => ({
  ...admission,
  Authorization: 'Bearer ' + owner,
  Origin: origin,
});
const cliHeaders = () => ({
  ...admission,
  Authorization: 'Bearer ' + cli,
  Origin: origin,
});
const webHeaders = () => ({ ...admission, Cookie: cookie, Origin: origin });
async function api(
  path: string,
  body?: any,
  headers: Record<string, string> = webHeaders(),
  request = randomUUID(),
  intent?: string,
) {
  const r = await endpointFetch(origin, path, body, {
    ...headers,
    'Idempotency-Key': request,
    ...(intent ? { 'X-CoC-Operation-Instance': intent } : {}),
  });
  const b: any = await r.json();
  assert(r.ok, JSON.stringify(b));
  return b;
}
async function enroll(role: string) {
  const { b, r } = await control('/auth/device/start', {
    role,
    name: 'opaque-' + role,
    ...(host ? { requestedHostId: host } : {}),
  });
  await control('/admin/approve', { id: b.id }, ownerHeaders());
  return control(
    '/auth/device/poll',
    { id: b.id, pollSecret: b.pollSecret },
    role === 'web'
      ? { Cookie: r.headers.get('set-cookie')!.split(';')[0] }
      : {},
  );
}
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  if (!online)
    start(
      process.execPath,
      [
        'node_modules/wrangler/bin/wrangler.js',
        'dev',
        '--ip',
        '127.0.0.1',
        '--port',
        String(port),
        '--persist-to',
        join(root, 'worker'),
        '--var',
        'ACCESS_ENABLED:false',
        '--var',
        'OWNER_SECRET:' + secret,
      ],
      {
        ...process.env,
        WRANGLER_LOG_PATH: join(root, 'wrangler.log'),
        WRANGLER_SEND_METRICS: 'false',
      },
    );
  await wait(
    async () => (await fetch(origin + '/api/v1/healthz')).ok,
    'Worker boot',
    60000,
  );
  owner = (await control('/auth/login', { secret, kind: 'cli' })).b.token;
  const enrolled = (await enroll('agent')).b;
  host = enrolled.hostId;
  cli = (await enroll('cli')).b.token;
  cookie = (await enroll('web')).r.headers.get('set-cookie')!.split(';')[0];
  const config = {
    relayUrl: origin,
    hostId: host,
    token: enrolled.token,
    dataDir: join(root, 'agent'),
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    codexProxyMode: 'direct',
    sandbox: 'workspace-write',
    terminal: { enabled: true },
    ...(options['access-config']
      ? { cloudflareAccessFile: resolve(options['access-config']) }
      : {}),
    projects: [{ id: 'project', name: '私有项目', path: root }],
  };
  const configPath = join(root, 'agent.json');
  writeFileSync(configPath, JSON.stringify(config));
  start(resolve(options.agent || 'build/coc-agent'), [
    'run',
    '--config',
    configPath,
  ]);
  await wait(() => logs.includes('Agent connected'), 'Agent registration');
  const state = await api(`/hosts/${host}/probe`, {}, cliHeaders());
  assert.equal(typeof state.operationInstance, 'string');
  assert.equal(
    (await api(`/hosts/${host}/projects`, undefined, cliHeaders()))[0].name,
    '私有项目',
  );
  const denied = await endpointFetch(
    origin,
    `/hosts/${host}/project-management`,
    { operation: 'register' },
    cliHeaders(),
  );
  assert.equal(((await denied.json()) as any).error.code, 'FORBIDDEN');
  const metadata = await api(
    `/admin/hosts/${host}/configuration`,
    undefined,
    ownerHeaders(),
  );
  assert.equal(
    metadata.targets.find((t: any) => t.id === 'agent').path,
    configPath,
  );
  const content = await api(
    `/admin/hosts/${host}/configuration`,
    { command: { action: 'read' } },
    ownerHeaders(),
  );
  assert(content.text.includes('私有项目'));
  const request = randomUUID(),
    body = { hostId: host, projectId: 'project', mode: 'web' };
  const session = await api(
    '/sessions',
    body,
    webHeaders(),
    request,
    state.operationInstance,
  );
  assert.equal(
    (
      await api(
        '/sessions',
        body,
        webHeaders(),
        request,
        state.operationInstance,
      )
    ).id,
    session.id,
  );
  await wait(
    async () => (await api(`/sessions/${session.id}`)).state === 'ready',
    'session start',
  );
  const claim = await api(`/sessions/${session.id}/attach`, {
    claimId: 'claim',
    delivery: 2,
  });
  const p = new EndpointPeer(origin, host, webHeaders(), {
    type: 'open',
    path: '/ws/v1/web/' + session.id,
  });
  peers.push(p);
  const messages: any[] = [];
  p.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  await new Promise<void>((r, j) => {
    p.once('open', r);
    p.once('error', j);
  });
  p.send(JSON.stringify({ type: 'auth', ticket: claim.ticket }));
  await wait(() => messages.some((d) => d.type === 'attached'), 'attach');
  const attached = messages.find((d) => d.type === 'attached');
  const window = new WindowPeer(p as any, messages, 'web', attached.control);
  await wait(() => window.ready, 'CONTROL_READY');
  window.send(JSON.stringify({ action: 'models', requestId: 'models' }));
  await wait(
    () => messages.some((d) => d.requestId === 'models'),
    'model list',
  );
  window.send(
    JSON.stringify({
      action: 'prompt',
      requestId: 'prompt-marker-private',
      text: 'secret-prompt-不可见',
    }),
  );
  await wait(
    () => messages.some((d) => d.event?.type === 'turn/completed'),
    'task complete',
  );
  writeFileSync(
    join(root, 'secret-file.txt'),
    '私有内容-' + '文'.repeat(30000),
  );
  const file = await api(`/hosts/${host}/files`, {
    operation: 'read',
    projectId: 'project',
    path: 'secret-file.txt',
    offset: 0,
  });
  assert(Buffer.from(file.data, 'base64').toString().startsWith('私有内容'));
  assert(await api(`/sessions/${session.id}/snapshot?historyVersion=2`));
  assert(
    (await api('/sessions?hostId=' + host + '&paged=true')).data.some(
      (s: any) => s.id === session.id,
    ),
  );
  const replacement = await api(`/sessions/${session.id}/takeover`, {
    claimId: 'takeover',
    delivery: 2,
  });
  assert.notEqual(replacement.ticket, claim.ticket);
  assert.equal(
    (
      await api(`/sessions/${session.id}/attach`, {
        claimId: 'takeover',
        delivery: 2,
      })
    ).ticket,
    replacement.ticket,
  );
  assert(!p.visible.join('\n').includes('secret-prompt-不可见'));
  assert(!p.visible.join('\n').includes(session.id));
  const directory = (await control('/admin/hosts', undefined, ownerHeaders()))
    .b;
  assert(!JSON.stringify(directory).includes('operationInstance'));
  assert(!JSON.stringify(directory).includes('build'));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  if (online)
    await context.route('https://r2.xlogic.cc/**', (route) =>
      route.continue({
        headers: { ...route.request().headers(), ...admission },
      }),
    );
  const [name, value] = cookie.split('=');
  await context.addCookies([
    { name, value, url: origin, httpOnly: true, sameSite: 'Strict' },
  ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await page.locator('.chat-workspace').waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  if (online) {
    mkdirSync('.local/r2-deployment', { recursive: true });
    await page.screenshot({
      path: '.local/r2-deployment/online-desktop.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: '.local/r2-deployment/online-mobile.png',
      fullPage: true,
    });
  }
  await context.close();
  report.checks.push(
    'encrypted projects, configuration and permission denial',
    'session create original request deduplication',
    'CONTROL_READY, models, prompt and streamed task completion',
    'file byte transfer and history',
    'control takeover and stable retry ticket',
    'ciphertext excludes prompt and session ID',
    'Worker directory excludes business metadata',
    'Chromium desktop/mobile without page errors',
  );
  // Revoke only the disposable r2 test host; production is a different Worker.
  if (online) {
    const devices = (await control('/admin/devices', undefined, ownerHeaders()))
      .b.credentials;
    for (const device of devices.filter((d: any) => d.hostId === host))
      await control('/admin/revoke', { id: device.id }, ownerHeaders());
  }
  report.passed = true;
  console.log(
    'PASS: real Worker + native Agent + browser encrypted projects, permissions, configuration, original deduplication, control, tasks, files, history, takeover and opaque directory',
  );
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  if (online) {
    mkdirSync('.local/r2-deployment', { recursive: true });
    writeFileSync(
      '.local/r2-deployment/online-test.json',
      JSON.stringify(report, null, 2) + '\n',
    );
  }
  await browser?.close();
  for (const p of peers) p.terminate();
  for (const c of children.reverse()) c.kill('SIGTERM');
  await Promise.all(
    children.map(
      (c) =>
        new Promise<void>((r) => {
          if (c.exitCode !== null || c.signalCode) r();
          else {
            c.once('exit', () => r());
            setTimeout(() => {
              c.kill('SIGKILL');
              r();
            }, 3000).unref();
          }
        }),
    ),
  );
  writeFileSync(
    online
      ? '.local/r2-deployment/agent-test.log'
      : '/tmp/opaque-e2e-detail.log',
    logs,
    { mode: 0o600 },
  );
  rmSync(root, { recursive: true, force: true });
}

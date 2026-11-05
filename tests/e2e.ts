import { EndpointPeer, endpointFetch } from './helpers/endpoint-peer.ts';
import { browserSessionStress } from './helpers/browser-session-stress.ts';
import { resolveAsync } from './helpers/async-http.ts';
import { OriginalHttpRequests } from './helpers/original-http.ts';
import { WindowPeer } from './helpers/window-peer.ts';
const originals = new OriginalHttpRequests();
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { chromium, expect, type Page } from '@playwright/test';
import { Agent } from './support/native-agent.ts';
import { SharedApprovals } from './fixtures/shared-approvals.ts';

const dir = mkdtempSync(join(tmpdir(), 'coc-e2e-'));
const revocationDir = mkdtempSync(join(tmpdir(), 'coc-e2e-revocation-'));
const artifacts = process.env.COC_ARTIFACT_DIR || '.local';
const secret = randomBytes(32).toString('hex');
const server = createServer();
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const port = (server.address() as any).port;
await new Promise<void>((r) => server.close(() => r()));
const origin = `http://127.0.0.1:${port}`;
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
    'ACCESS_ENABLED:false',
  ],
  {
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  },
);
let logs = '';
worker.stdout.on('data', (d) => {
  logs += d;
});
worker.stderr.on('data', (d) => {
  logs += d;
});
let adminToken = '',
  token = '',
  cookie = '',
  agent: Agent | undefined,
  otherAgent: Agent | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const sockets: (WebSocket | EndpointPeer)[] = [];
let wakeService: ReturnType<typeof createHttpServer> | undefined;
const sharedApprovals = new SharedApprovals(dir);
const approvalEndpoint = await sharedApprovals.ready();
async function wait(
  test: () => boolean | Promise<boolean>,
  label: string,
  timeout = 15000,
) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await test()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Timeout: ' + label);
}
async function request(
  path: string,
  data?: unknown,
  options: {
    anonymous?: boolean;
    key?: string;
    origin?: string;
    admin?: boolean;
    cookie?: string;
    ip?: string;
  } = {},
) {
  if (data && /\/(attach|takeover)$/.test(path))
    data = { ...(data as object), delivery: 2 };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-CoC-Async': '1',
    'X-CoC-Delivery': '2',
    Origin: options.origin || origin,
  };
  if (options.admin) headers.Authorization = 'Bearer ' + adminToken;
  else if (!options.anonymous) {
    if (token) headers.Authorization = 'Bearer ' + token;
    else if (cookie) headers.Cookie = cookie;
  }
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.ip) headers['CF-Connecting-IP'] = options.ip;
  if (data !== undefined)
    headers['Idempotency-Key'] = options.key || randomUUID();
  await originals.prepare(
    path,
    data,
    headers,
    async (probe) => (await request(probe, {}, options)).b,
  );
  const response = await endpointFetch(origin, path, data, headers);
  const r = await resolveAsync(
    response,
    origin,
    headers,
    options.admin === true,
  );
  const b: any = await r.json();
  return { r, b };
}
async function api(path: string, data?: unknown, opts: any = {}) {
  const { r, b } = await request(path, data, opts);
  assert.equal(r.status, 200, JSON.stringify(b));
  return b;
}
function peer(path: string, auth?: string) {
  // Local workerd may leave TCP half-closed after a valid close frame.
  const options = {
    closeTimeout: 1000,
    headers: {
      'X-CoC-Delivery': '2',
      Origin: origin,
      ...(auth ? { Authorization: 'Bearer ' + auth } : { Cookie: cookie }),
    },
  };
  const host = path.match(/\/ws\/v1\/(?:web|cli|history)\/([\w-]+)~/)?.[1];
  const ws = host
    ? new EndpointPeer(
        origin,
        host,
        {
          ...options.headers,
          ...(/\/cli\//.test(path) ? { Authorization: 'Bearer ' + token } : {}),
        },
        {
          type: 'open',
          path: path + (/\/cli\//.test(path) && auth ? '?ticket=' + auth : ''),
        },
      )
    : new WebSocket(origin.replace('http', 'ws') + path, options);
  let closeCode: number | undefined;
  ws.on('close', (code) => {
    closeCode = code;
  });
  const messages: any[] = [];
  ws.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    messages.push(message);
    if (message.receiptId)
      ws.send(
        JSON.stringify({ type: 'receipt', receiptId: message.receiptId }),
      );
  });
  ws.on('error', () => {});
  sockets.push(ws);
  return {
    ws,
    messages,
    send: (text: string) => ws.send(text),
    get closeCode() {
      return closeCode;
    },
  };
}
async function readyControl(p: ReturnType<typeof peer>) {
  await wait(() => p.messages.some((m) => m.control), 'controller binding');
  const binding = [...p.messages].reverse().find((m) => m.control);
  const mode = binding.type === 'delivery-ready' ? 'cli' : 'web';
  const endpoint = new WindowPeer(
    p.ws as WebSocket,
    p.messages,
    mode,
    binding.control,
  );
  await wait(() => endpoint.ready, 'Agent CONTROL_READY');
  p.send = endpoint.send;
}
async function web(id: string, takeover = false, claimId = randomUUID()) {
  const t = await api(`/sessions/${id}/${takeover ? 'takeover' : 'attach'}`, {
    claimId,
  });
  const p = peer('/ws/v1/web/' + id);
  await new Promise<void>((r, j) => {
    p.ws.once('open', r);
    p.ws.once('error', j);
  });
  p.send(JSON.stringify({ type: 'auth', ticket: t.ticket }));
  await wait(
    () =>
      p.messages.some((m) => m.type === 'attached' || m.type === 'error') ||
      p.closeCode !== undefined,
    'web attach',
  );
  assert(
    p.messages.some((m) => m.type === 'attached'),
    JSON.stringify(p.messages),
  );
  await readyControl(p);
  return p;
}
const pass = (message: string) => console.log('PASS: ' + message);
async function feature(page: Page, name: RegExp) {
  if (await page.getByRole('dialog').isVisible())
    await page.getByRole('button', { name: '关闭面板' }).click();
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page
    .getByRole('navigation', { name: '功能菜单' })
    .getByRole('button', { name })
    .click();
}
async function idle(page: Page) {
  await wait(
    async () =>
      (await page.locator('.composer').count()) === 1 &&
      (await page.locator('.composer [role="status"], .thinking').count()) ===
        0,
    'chat ready',
    90000,
  );
}
async function sessionId(page: Page) {
  await feature(page, /^会话详情/);
  await page.getByRole('dialog').getByText('会话标识', { exact: true }).click();
  const id = await page.getByRole('dialog').locator('.id').innerText();
  await page.getByRole('button', { name: '关闭面板' }).click();
  return id;
}
async function focusedChat(page: Page) {
  // Approval and injected-disconnect checks can leave a dismissible advisory.
  // Close it before measuring the normal chat layout, as a user would.
  const dismiss = page
    .locator('.notice')
    .getByRole('button', { name: '关闭', exact: true });
  if (await dismiss.isVisible()) await dismiss.click();
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByLabel('主机').count(), 0);
  assert.equal(
    await page
      .locator(
        '.page-heading, footer, .conversation .id, .conversation .status, .session-sidebar',
      )
      .count(),
    0,
  );
  const geometry = await page.evaluate(() => {
    const chat = document
      .querySelector('.conversation')!
      .getBoundingClientRect();
    const messages = document
      .querySelector('.messages')!
      .getBoundingClientRect();
    const composer = document
      .querySelector('.composer')!
      .getBoundingClientRect();
    return {
      height: innerHeight,
      width: innerWidth,
      chatHeight: chat.height,
      toolbarHeight:
        document.querySelector('.workbench-toolbar')?.getBoundingClientRect()
          .height || 0,
      sessionHeadingHeight:
        document
          .querySelector('.happier-session-heading')
          ?.getBoundingClientRect().height || 0,
      messageHeight: messages.height,
      composerBottom: composer.bottom,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
  assert(
    geometry.chatHeight + geometry.toolbarHeight > geometry.height * 0.85,
    JSON.stringify(geometry),
  );
  assert.equal(await page.locator('.workspace-context').isVisible(), true);
  assert(
    geometry.messageHeight +
      geometry.toolbarHeight +
      geometry.sessionHeadingHeight >
      geometry.height * 0.65,
    JSON.stringify(geometry),
  );
  assert(
    geometry.sessionHeadingHeight <= 64,
    'CW has one compact session header',
  );
  assert(geometry.composerBottom <= geometry.height);
  assert(geometry.scrollWidth <= geometry.width);
  assert(geometry.scrollHeight <= geometry.height);
}

async function cliCommand(
  args: string[],
  input = '',
  env: NodeJS.ProcessEnv = {},
  binary = process.env.COC_CLI_BINARY || 'build/coc-client',
  approval?: {
    hostId: string;
    message?: string;
    page?: Page;
    agentConfig?: string;
  },
) {
  const child = spawn(resolve(binary), args, {
    env: {
      ...process.env,
      COC_CREDENTIALS: join(dir, 'credentials.json'),
      COC_HISTORY_DIR: join(dir, 'client-history'),
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  let approving = false;
  child.stdout.on('data', (d) => {
    stdout += d;
    const id = stdout.match(/#authorize=([\w-]+)/)?.[1];
    if (id && !approving) {
      approving = true;
      void (async () => {
        if (approval) {
          const pending = (
            await api('/admin/devices', undefined, { admin: true })
          ).pending.find((d: any) => d.id === id);
          assert.equal(pending.role, 'cli');
          assert.equal(pending.hostId, undefined);
          assert.equal(pending.message, approval.message || '');
          if (approval.agentConfig) {
            const agentBinary =
              process.env.COC_AGENT_BINARY || 'build/coc-agent';
            const listed = JSON.parse(
              await cliCommand(
                ['requests', '--config', approval.agentConfig],
                '',
                {},
                agentBinary,
              ),
            );
            assert.equal(listed.hostId, approval.hostId);
            assert(
              listed.pending.some(
                (request: any) =>
                  request.id === id &&
                  request.requestedHostId === approval.hostId,
              ),
            );
            assert.equal(
              listed.pending.find((request: any) => request.id === id).pollHash,
              undefined,
            );
            assert.deepEqual(
              JSON.parse(
                await cliCommand(
                  ['approve', id, '--config', approval.agentConfig],
                  '',
                  {},
                  agentBinary,
                ),
              ),
              { ok: true },
            );
            return;
          }
          if (approval.page) {
            await approval.page
              .getByLabel('目标服务器 ' + pending.code, { exact: true })
              .selectOption(approval.hostId);
            await approval.page.screenshot({
              path: join(artifacts, 'cc-admin-select-server.png'),
              fullPage: true,
            });
            await approval.page
              .getByRole('button', {
                name: '批准 ' + pending.code,
                exact: true,
              })
              .click();
            return;
          }
        }
        await api(
          '/admin/approve',
          { id, ...(approval ? { hostId: approval.hostId } : {}) },
          { admin: true },
        );
      })().catch((e) => {
        stderr += String(e);
        child.kill();
      });
    }
  });
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(input);
  await new Promise<void>((r, j) => {
    child.on('error', j);
    child.on('exit', (code) =>
      code === 0 ? r() : j(new Error('C++ CLI failed: ' + stderr)),
    );
  });
  return stdout;
}

try {
  await wait(
    async () => {
      try {
        if (worker.exitCode !== null) throw new Error('Worker exited');
        return (
          await fetch(origin + '/api/v1/healthz', {
            signal: AbortSignal.timeout(1000),
          })
        ).ok;
      } catch {
        if (worker.exitCode !== null)
          throw new Error('Wrangler exited before becoming ready');
        return false;
      }
    },
    'Wrangler startup',
    60000,
  );
  assert.equal((await request('/hosts')).r.status, 401);
  assert.equal(
    (
      await request(
        '/auth/login',
        { secret: 'wrong', kind: 'cli' },
        { anonymous: true },
      )
    ).r.status,
    401,
  );
  const login = await request(
    '/auth/login',
    { secret, kind: 'cli' },
    { anonymous: true },
  );
  assert.equal(login.r.status, 200);
  adminToken = login.b.token;
  assert.equal((await request('/admin/devices')).r.status, 401);
  assert.equal(
    (
      await request(
        '/admin/approve',
        { id: 'invalid' },
        { admin: true, origin: 'https://evil.example' },
      )
    ).r.status,
    403,
  );
  assert.equal(
    (await request('/hosts', undefined, { admin: true })).r.status,
    403,
  );
  const configFile = join(dir, 'enrolled.json');
  await cliCommand(
    [
      'login',
      '--relay',
      origin,
      '--config',
      configFile,
      '--name',
      'local-test',
      '--project',
      dir,
      '--project-id',
      'test-project',
    ],
    '',
    {},
    process.env.COC_AGENT_BINARY || 'build/coc-agent',
  );
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const homepage = await fetch(origin + '/');
  assert.equal(homepage.status, 200);
  for (const header of [
    'Content-Security-Policy',
    'X-Content-Type-Options',
    'Referrer-Policy',
  ])
    assert(homepage.headers.get(header), header);
  pass('real static resource routing applies security response headers');
  const enrolled = { hostId: config.hostId, token: config.token };
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  await cliCommand(
    ['login', '--relay', origin, '--message', '请授权开发服务器'],
    '',
    {},
    undefined,
    { hostId: enrolled.hostId, message: '请授权开发服务器' },
  );
  const clientCredentials = JSON.parse(
    readFileSync(join(dir, 'credentials.json'), 'utf8'),
  ).entries[0];
  assert.equal(statSync(join(dir, 'credentials.json')).mode & 0o777, 0o600);
  token = clientCredentials.token;
  assert.equal((await request('/admin/devices')).r.status, 403);
  assert.equal((await request('/agent/status')).r.status, 403);
  assert.equal((await request('/auth/codes', {})).r.status, 404);
  assert.equal((await request('/agent/enroll', { code: 'old' })).r.status, 404);
  assert.equal(JSON.parse(await cliCommand(['hosts']))[0].id, enrolled.hostId);
  const otherStart = await api(
    '/auth/device/start',
    { role: 'agent', name: 'other-agent' },
    { anonymous: true },
  );
  await api('/admin/approve', { id: otherStart.id }, { admin: true });
  const other = await api(
    '/auth/device/poll',
    { id: otherStart.id, pollSecret: otherStart.pollSecret },
    { anonymous: true },
  );
  assert.equal(
    (await request('/hosts/' + other.hostId + '/projects')).r.status,
    403,
  );
  assert.equal(
    (await request('/sessions?hostId=' + other.hostId)).r.status,
    403,
  );
  await cliCommand(['login', '--relay', origin], '', {}, undefined, {
    hostId: other.hostId,
  });
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')).entries
      .length,
    2,
  );
  await cliCommand(['use', '--host', enrolled.hostId]);
  const targetedCliFile = join(dir, 'agent-approved-client.json');
  await cliCommand(
    [
      'login',
      '--relay',
      origin,
      '--host',
      enrolled.hostId,
      '--config',
      targetedCliFile,
      '--message',
      '请目标 Agent 批准',
    ],
    '',
    {},
    undefined,
    {
      hostId: enrolled.hostId,
      message: '请目标 Agent 批准',
      agentConfig: configFile,
    },
  );
  assert.equal(
    JSON.parse(readFileSync(targetedCliFile, 'utf8')).entries[0].hostId,
    enrolled.hostId,
  );
  pass(
    'CC explicitly targets its Agent and native Agent approves without a running daemon or administrator approval',
  );
  const webStart = await request(
    '/auth/device/start',
    { role: 'web', name: 'API web', message: 'API browser request' },
    { anonymous: true },
  );
  assert.equal(webStart.b.pollSecret, undefined);
  const pendingCookie = webStart.r.headers.get('set-cookie')!.split(';')[0];
  await api(
    '/admin/approve',
    { id: webStart.b.id, hostId: enrolled.hostId },
    { admin: true },
  );
  const redeemed = await request(
    '/auth/device/poll',
    { id: webStart.b.id },
    { anonymous: true, cookie: pendingCookie },
  );
  assert.equal(redeemed.r.status, 200);
  assert.equal(redeemed.b.token, undefined);
  cookie = redeemed.r.headers.get('set-cookie')!.split(';')[0];
  assert(redeemed.r.headers.get('set-cookie')!.includes('HttpOnly'));
  assert.equal(
    (
      await request(
        '/auth/device/poll',
        { id: webStart.b.id },
        { anonymous: true, cookie: pendingCookie },
      )
    ).r.status,
    401,
  );
  token = '';
  pass(
    'native A/CC unified login, scoped credentials, administrator isolation, multi-A store and one-use CW delivery',
  );
  const startupRequest = await api(
    '/auth/device/start',
    {
      role: 'cli',
      name: 'Startup client',
      requestedHostId: enrolled.hostId,
      message: '请核对配对码\n\u001b[31m不是命令',
    },
    { anonymous: true, ip: '192.0.2.26' },
  );
  const foreignRequest = await api(
    '/auth/device/start',
    {
      role: 'web',
      name: 'Other host client',
      requestedHostId: other.hostId,
    },
    { anonymous: true, ip: '192.0.2.26' },
  );
  const unassignedRequest = await api(
    '/auth/device/start',
    {
      role: 'cli',
      name: 'Unassigned client',
    },
    { anonymous: true, ip: '192.0.2.26' },
  );
  const approvalNotices = (a: Agent) =>
    a.output
      .split('\n')
      .filter((line) => line.includes('"event":"client_approval_required"'))
      .map((line) => JSON.parse(line));
  let wakeRequests = 0;
  wakeService = createHttpServer((req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.authorization, undefined);
    assert.equal(req.headers.cookie, undefined);
    wakeRequests++;
    if (wakeRequests === 1) agent!.start();
    res.writeHead(202).end();
  });
  await new Promise<void>((done) => wakeService!.listen(0, '127.0.0.1', done));
  const wakeUrl = `http://127.0.0.1:${(wakeService.address() as { port: number }).port}/wake?key=test-only`;
  await cliCommand(
    ['wake-url', wakeUrl, '--config', configFile],
    '',
    {},
    process.env.COC_AGENT_BINARY || 'build/coc-agent',
  );
  agent = new Agent({
    codexProxyMode: 'direct',
    relayUrl: origin,
    hostId: enrolled.hostId,
    token: enrolled.token,
    wakeUrl,
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    sandbox: 'workspace-write',
    terminal: { enabled: process.env.COC_TEST_TERMINAL === '1' },
    externalSessions: {
      allowQueue: true,
      allowApprovals: true,
      approvalEndpoint,
    },
    dataDir: join(dir, 'agent'),
    projects: [{ id: 'test-project', name: 'Test project', path: dir }],
  });
  const wokenProjects = JSON.parse(
    await cliCommand(['projects', '--host', enrolled.hostId]),
  );
  assert.equal(wokenProjects[0].id, 'test-project');
  assert.equal(wakeRequests, 1);
  await wait(async () => (await api('/hosts'))[0].online, 'Agent online');
  assert.equal(
    (await api(`/hosts/${enrolled.hostId}/wake`, {})).state,
    'online',
  );
  assert.equal(wakeRequests, 1);
  const wakeHosts = await api('/hosts');
  assert.equal(wakeHosts[0].wakeConfigured, true);
  assert(!JSON.stringify(wakeHosts).includes('test-only'));
  assert.equal(
    (await api('/admin/hosts', undefined, { admin: true })).find(
      (h: any) => h.id === enrolled.hostId,
    ).agentWakeUrl,
    wakeUrl,
  );
  pass(
    'native CC wakes offline Agent through real Worker GET, waits for startup, and keeps wake URL private',
  );
  await wait(
    () => approvalNotices(agent!).some((n) => n.id === startupRequest.id),
    'startup pending client approval notice',
  );
  assert.deepEqual(
    approvalNotices(agent).map((n) => n.id),
    [startupRequest.id],
  );
  assert.equal(approvalNotices(agent)[0].code, startupRequest.code);
  assert(
    agent.output.includes(
      'coc-agent approve ' + startupRequest.id + ' --config ',
    ),
  );
  assert(
    agent.output.includes(
      'coc-agent reject ' + startupRequest.id + ' --config ',
    ),
  );
  assert(!agent.output.includes('\u001b[31m'));
  assert(!agent.output.includes(startupRequest.pollSecret));
  assert.equal(
    (
      await api(
        '/auth/device/poll',
        {
          id: startupRequest.id,
          pollSecret: startupRequest.pollSecret,
        },
        { anonymous: true },
      )
    ).state,
    'pending',
  );
  await api('/admin/reject', { id: unassignedRequest.id }, { admin: true });
  pass(
    'Agent startup reports only explicitly targeted pending requests with escaped text and manual commands; no automatic approval',
  );
  otherAgent = new Agent({
    codexProxyMode: 'direct',
    relayUrl: origin,
    hostId: other.hostId,
    token: other.token,
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    sandbox: 'workspace-write',
    dataDir: join(dir, 'other-agent'),
    projects: [{ id: 'other-project', name: 'Other project', path: dir }],
  });
  otherAgent.approvalStatus = 503;
  otherAgent.start();
  await wait(
    async () =>
      JSON.parse(await cliCommand(['status', '--host', other.hostId]))[0]
        .online,
    'other Agent online',
  );
  await wait(
    () => otherAgent!.output.includes('client_approval_check_failed'),
    'approval check failure warns without stopping Agent',
  );
  otherAgent.approvalStatus = undefined;
  // Exercise recovery while these five-minute device requests are still valid.
  await api('/admin/reject', { id: startupRequest.id }, { admin: true });
  const recoveryRequest = await api(
    '/auth/device/start',
    {
      role: 'web',
      name: 'Approval recovery event',
      requestedHostId: other.hostId,
    },
    { anonymous: true, ip: 'approval-recovery-event' },
  );
  await wait(
    () => approvalNotices(otherAgent!).some((n) => n.id === foreignRequest.id),
    'approval check recovers on the next real request event',
    40000,
  );
  await api('/admin/reject', { id: foreignRequest.id }, { admin: true });
  await api('/admin/reject', { id: recoveryRequest.id }, { admin: true });
  assert.equal(
    JSON.parse(await cliCommand(['projects', '--host', 'local-test']))[0].id,
    'test-project',
  );
  assert.equal(
    (
      await request('/sessions', {
        hostId: enrolled.hostId,
        projectId: 'not-allowed',
        mode: 'web',
      })
    ).r.status,
    404,
  );
  const fileEndpoint = `/hosts/${enrolled.hostId}/files`;
  assert.equal(
    (
      await request(
        fileEndpoint,
        { operation: 'list', projectId: 'test-project' },
        { anonymous: true },
      )
    ).r.status,
    401,
  );
  token = clientCredentials.token;
  assert.equal(
    (
      await request(fileEndpoint, {
        operation: 'list',
        projectId: 'test-project',
      })
    ).r.status,
    403,
  );
  token = '';
  assert.equal(
    (
      await request(`/hosts/${other.hostId}/files`, {
        operation: 'list',
        projectId: 'other-project',
      })
    ).r.status,
    401,
  );
  assert.equal(
    (
      await request(fileEndpoint, {
        operation: 'list',
        projectId: 'not-allowed',
      })
    ).b.error.code,
    'PROJECT_NOT_FOUND',
  );
  assert.equal(
    (
      await request(fileEndpoint, {
        operation: 'read',
        projectId: 'test-project',
        path: '../escape',
      })
    ).b.error.code,
    'INVALID_PATH',
  );
  assert.equal(
    (
      await request(fileEndpoint, {
        operation: 'begin',
        projectId: 'test-project',
        path: 'too-large',
        uploadId: 'large',
        sha256: 'a'.repeat(64),
        size: 20 * 1024 * 1024 + 1,
      })
    ).r.status,
    400,
  );
  pass(
    'file endpoint authentication, web role, host/project scope, path validation and size limit',
  );
  const history = await api(
    `/hosts/${enrolled.hostId}/threads?projectId=test-project`,
  );
  assert.deepEqual(
    history.data.map((t: any) => t.id),
    ['local-history', 'external-history'],
  );
  assert(Buffer.byteLength(history.data[0].preview) <= 500);
  assert(!history.data[0].preview.includes('�'));
  assert(history.data[0].preview.includes('你好'));
  assert.equal(
    (await request(`/hosts/${other.hostId}/threads?projectId=other-project`)).r
      .status,
    401,
  );
  assert.equal(
    (
      await request('/sessions', {
        hostId: enrolled.hostId,
        projectId: 'test-project',
        mode: 'web',
        threadId: 'foreign-history',
      })
    ).r.status,
    403,
  );
  assert.equal(
    (
      await request('/sessions', {
        hostId: enrolled.hostId,
        projectId: 'test-project',
        mode: 'web',
        threadId: '../escape',
      })
    ).r.status,
    400,
  );
  pass(
    'local thread listing filters project metadata and rejects cross-host/project resume',
  );
  {
    const probe = await api(`/hosts/${enrolled.hostId}/probe`, {});
    const instance = probe.operationInstance;
    assert.equal(typeof instance, 'string');
    const original = randomUUID();
    const body = {
      hostId: enrolled.hostId,
      projectId: 'test-project',
      mode: 'web',
    };
    const originalRequest = async (
      path: string,
      data: unknown,
      key: string,
      ack = false,
    ) => {
      const headers = {
        'Content-Type': 'application/json',
        'X-CoC-Async': '1',
        'X-CoC-Delivery': '2',
        'Idempotency-Key': key,
        'X-CoC-Operation-Instance': instance,
        ...(ack ? { 'X-CoC-Operation-Ack': '1' } : {}),
        ...(token ? { Authorization: 'Bearer ' + token } : { Cookie: cookie }),
        Origin: origin,
      };
      const response = await endpointFetch(origin, path, data, headers);
      const result: any = await response.json();
      const intentText = response.headers.get('X-CoC-Intent');
      const receipt: any = {
        state: 'completed',
        ...(result.error ? { error: result.error } : { result }),
        ...(intentText ? { intent: JSON.parse(intentText) } : {}),
      };
      return receipt;
    };
    const created = await originalRequest('/sessions', body, original);
    assert(!created.error, JSON.stringify(created.error));
    assert.equal(created.intent.instance, instance);
    assert.equal(created.intent.requestId, original);
    assert.match(created.intent.owner, /^[a-f0-9]{64}$/);
    const repeated = await originalRequest('/sessions', body, original);
    assert.deepEqual(repeated.result, created.result);
    assert.deepEqual(repeated.intent, created.intent);
    const conflict = await originalRequest(
      '/sessions',
      { ...body, projectId: 'changed-project' },
      original,
    );
    assert.equal(conflict.error.code, 'IDEMPOTENCY_CONFLICT');
    assert.equal(conflict.intent, undefined);
    const confirmed = await originalRequest('/sessions', body, original, true);
    assert.deepEqual(confirmed.result, { confirmed: true });
    const retired = await originalRequest('/sessions', body, original);
    assert.equal(retired.error.code, 'RESULT_UNAVAILABLE');
    const stopId = randomUUID();
    const stopPath = `/sessions/${created.result.id}/stop`;
    const stopped = await originalRequest(stopPath, {}, stopId);
    assert(!stopped.error, JSON.stringify(stopped.error));
    assert(['closing', 'closed'].includes(stopped.result.state));
    const stopConfirmed = await originalRequest(stopPath, {}, stopId, true);
    assert.deepEqual(stopConfirmed.result, { confirmed: true });
    pass(
      'HTTP original write identity survives forwarding retries; endpoint receipts, conflicts and result confirmation preserve session authorization',
    );
  }
  for (const threadId of ['external-history']) {
    const session = await api('/sessions', {
      hostId: enrolled.hostId,
      projectId: 'test-project',
      mode: 'web',
      threadId,
    });
    assert.equal(session.external, true);
    assert.equal(session.running, true);
    assert.equal(session.queueEnabled, true);
    const connection = await web(session.id);
    connection.send(JSON.stringify({ action: 'sync', after: 0 }));
    await wait(
      () => connection.messages.some((m) => m.type === 'sync'),
      'external sync',
    );
    const queuedId = randomUUID();
    const queued = await api(
      `/sessions/${session.id}/queue`,
      { text: 'queued while owner is running' },
      { key: queuedId },
    );
    const repeated = await api(
      `/sessions/${session.id}/queue`,
      { text: 'queued while owner is running' },
      { key: queuedId },
    );
    assert.equal(queued.state, 'queued');
    assert.equal(queued.queueId, repeated.queueId);
    if (threadId === 'external-history') {
      const priorQueueAdds = JSON.parse(
        readFileSync(join(dir, '.fake-external.json'), 'utf8'),
      ).queueAdds;
      const lostId = randomUUID();
      const unconfirmed = await request(
        `/sessions/${session.id}/queue`,
        { text: 'lost queue reply' },
        { key: lostId },
      );
      if (unconfirmed.b.error)
        assert.equal(unconfirmed.b.error.code, 'RESULT_UNKNOWN');
      else assert.equal(unconfirmed.b.state, 'queued');
      const reconciled = await request(
        `/sessions/${session.id}/queue`,
        { text: 'lost queue reply' },
        { key: lostId },
      );
      assert.equal(reconciled.b.state, 'queued');
      const persisted = JSON.parse(
        readFileSync(join(dir, '.fake-external.json'), 'utf8'),
      );
      assert.equal(
        persisted.queueAdds,
        priorQueueAdds + 1,
        'Original request lookup must not repeat queue/add',
      );
      assert.equal(
        reconciled.b.queueId,
        persisted.queue.find(
          (q: any) => q.input?.[0]?.text === 'lost queue reply',
        ).id,
      );
      assert.equal(
        persisted.queue.filter(
          (q: any) => q.input?.[0]?.text === 'lost queue reply',
        ).length,
        1,
      );
    }
    const file = join(dir, '.fake-external.json');
    let state = JSON.parse(readFileSync(file, 'utf8'));
    const count = state.queue.length;
    assert.equal(
      state.queue.filter(
        (q: any) => q.clientUserMessageId === queued.clientUserMessageId,
      ).length,
      1,
    );
    assert.equal(
      (
        await request(
          `/sessions/${session.id}/queue`,
          { text: 'changed payload' },
          { key: queuedId },
        )
      ).r.status,
      409,
    );
    const promptId = randomUUID();
    connection.send(
      JSON.stringify({
        action: 'prompt',
        requestId: promptId,
        text: 'WebSocket queue',
      }),
    );
    await wait(
      () =>
        connection.messages.some(
          (m) => m.type === 'ack' && m.requestId === promptId,
        ),
      'external websocket queue',
    );
    state = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(state.queue.length, count + 1);
    for (const command of [
      { action: 'models' },
      {
        action: 'prompt',
        text: 'must not queue a model override',
        model: 'test-model-alt',
      },
    ]) {
      const requestId = randomUUID();
      connection.send(JSON.stringify({ ...command, requestId }));
      await wait(
        () =>
          connection.messages.some(
            (m) => m.type === 'error' && m.requestId === requestId,
          ),
        'external model override rejected',
      );
      assert.equal(
        connection.messages.find(
          (m) => m.type === 'error' && m.requestId === requestId,
        ).error.code,
        'EXTERNAL_READ_ONLY',
      );
    }
    assert.equal(
      JSON.parse(readFileSync(file, 'utf8')).queue.length,
      count + 1,
    );
    state.items[state.items.length - 1].text = 'External reply grew 你好';
    writeFileSync(file, JSON.stringify(state));
    await wait(
      () =>
        connection.messages.some(
          (m) => m.event?.data?.delta === 'External reply grew 你好',
        ),
      'external snapshot refresh',
    );
    const changed = connection.messages.find(
      (m) => m.event?.data?.delta === 'External reply grew 你好',
    ).event;
    state.items[state.items.length - 1].text += ' again';
    writeFileSync(file, JSON.stringify(state));
    await wait(
      () =>
        connection.messages.some(
          (m) => m.event?.data?.delta === 'External reply grew 你好 again',
        ),
      'external second refresh',
    );
    const updated = connection.messages.find(
      (m) => m.event?.data?.delta === 'External reply grew 你好 again',
    ).event;
    assert.equal(changed.seq, updated.seq);
    assert(updated.revision > changed.revision);
    const interruptId = randomUUID();
    connection.send(
      JSON.stringify({
        action: 'interrupt',
        requestId: interruptId,
        target: {
          controlEpoch: 1,
          instance: 'journal',
          owner: 'client',
          requestId: 'web:original',
          stream: 'normal',
        },
      }),
    );
    await wait(
      () => connection.messages.some((m) => m.requestId === interruptId),
      'external interrupt refusal',
    );
    assert.equal(
      connection.messages.find((m) => m.requestId === interruptId).error.code,
      'EXTERNAL_READ_ONLY',
    );
    await api(`/sessions/${session.id}/stop`, {});
    assert.equal(
      JSON.parse(readFileSync(file, 'utf8')).queue.length,
      count + 1,
    );
    connection.ws.close();
  }
  pass(
    'external active-writer fallback, paginated snapshots, stable revisions, queue deduplication and safe disconnect',
  );
  const observed = JSON.parse(
    await cliCommand(['observe', 'external-cli', '--project', 'test-project']),
  );
  assert.equal(observed.mode, 'cli');
  assert.equal(observed.external, true);
  assert.equal(
    (await request(`/sessions/${observed.id}/queue`, { text: 'wrong role' })).r
      .status,
    403,
  );
  const cliQueue = JSON.parse(
    await cliCommand([
      'queue',
      observed.id,
      '--message',
      'CLI external input',
      '--request-id',
      'cli-external-request',
    ]),
  );
  assert.equal(cliQueue.state, 'queued');
  const cliStatus = JSON.parse(
    await cliCommand([
      'request',
      'cli-external-request',
      '--session',
      observed.id,
    ]),
  );
  assert.equal(cliStatus.state, 'completed');
  const cliHistory = JSON.parse(await cliCommand(['history', observed.id]));
  assert(
    cliHistory.events.some((e: any) => e.type === 'item/agentMessage/delta'),
  );
  await cliCommand(['stop', observed.id]);
  token = JSON.parse(
    readFileSync(join(dir, 'credentials.json'), 'utf8'),
  ).entries.find((e: any) => e.hostId === other.hostId).token;
  const readonlyObserved = await api('/sessions', {
    hostId: other.hostId,
    projectId: 'other-project',
    mode: 'cli',
    threadId: 'external-disabled',
    external: true,
  });
  assert.equal(readonlyObserved.queueEnabled, false);
  const deniedQueue = await request(`/sessions/${readonlyObserved.id}/queue`, {
    text: 'must not be queued',
  });
  assert.equal(deniedQueue.b.error.code, 'EXTERNAL_QUEUE_DISABLED');
  await api(`/sessions/${readonlyObserved.id}/stop`, {});
  token = '';
  pass(
    'native CLI observe/history/queue/request and queue disabled by default',
  );
  const sharedRequest = sharedApprovals.add('external-approval-cli');
  const approvalSession = JSON.parse(
    await cliCommand([
      'observe',
      'external-approval-cli',
      '--project',
      'test-project',
    ]),
  );
  let pendingApproval: any;
  await wait(async () => {
    const state = JSON.parse(
      await cliCommand(['approvals', approvalSession.id]),
    );
    pendingApproval = state.data.find(
      (a: any) => a.approvalId === 'external:' + JSON.stringify(sharedRequest),
    );
    return state.forwarding && !!pendingApproval;
  }, 'original pending approval replay');
  const approvalResult = JSON.parse(
    await cliCommand([
      'approve',
      approvalSession.id,
      '--approval-id',
      pendingApproval.approvalId,
      '--runtime-id',
      pendingApproval.runtimeId,
      '--approval-version',
      pendingApproval.approvalVersion,
      '--request-id',
      'stable-remote-approval',
    ]),
  );
  assert.equal(approvalResult.state, 'approval-submitted');
  await wait(
    () => sharedApprovals.decisions.has(sharedRequest),
    'remote approval accepted',
  );
  assert.deepEqual(sharedApprovals.decisions.get(sharedRequest), {
    decision: 'accept',
  });
  assert.equal(
    JSON.parse(
      await cliCommand([
        'approve',
        approvalSession.id,
        '--approval-id',
        pendingApproval.approvalId,
        '--runtime-id',
        pendingApproval.runtimeId,
        '--approval-version',
        pendingApproval.approvalVersion,
        '--request-id',
        'stable-remote-approval',
      ]),
    ).state,
    'approval-submitted',
  );
  const permissionsRequest = sharedApprovals.add(
    'external-approval-cli',
    'item/permissions/requestApproval',
  );
  await wait(
    async () =>
      JSON.parse(await cliCommand(['approvals', approvalSession.id])).data.some(
        (a: any) =>
          a.approvalId === 'external:' + JSON.stringify(permissionsRequest),
      ),
    'permission approval delivery',
  );
  const permissionsApproval = JSON.parse(
    await cliCommand(['approvals', approvalSession.id]),
  ).data.find(
    (a: any) =>
      a.approvalId === 'external:' + JSON.stringify(permissionsRequest),
  );
  await cliCommand([
    'approve',
    approvalSession.id,
    '--approval-id',
    permissionsApproval.approvalId,
    '--runtime-id',
    permissionsApproval.runtimeId,
    '--approval-version',
    permissionsApproval.approvalVersion,
  ]);
  await wait(
    () => sharedApprovals.decisions.has(permissionsRequest),
    'explicit permission grant',
  );
  assert.deepEqual(sharedApprovals.decisions.get(permissionsRequest), {
    permissions: { network: { enabled: true } },
    scope: 'turn',
  });
  const stale = sharedApprovals.add('external-approval-cli');
  await wait(
    async () =>
      JSON.parse(await cliCommand(['approvals', approvalSession.id])).data.some(
        (a: any) => a.approvalId === 'external:' + JSON.stringify(stale),
      ),
    'pending local resolution',
  );
  sharedApprovals.resolve(stale);
  await wait(
    async () =>
      JSON.parse(await cliCommand(['approvals', approvalSession.id])).data
        .length === 0,
    'original client resolution clears remote approval',
  );
  const unsupported = sharedApprovals.add(
    'external-approval-cli',
    'item/tool/requestUserInput',
  );
  await wait(
    async () =>
      JSON.parse(await cliCommand(['approvals', approvalSession.id])).data.some(
        (a: any) =>
          a.approvalId === 'external:' + JSON.stringify(unsupported) &&
          a.unsupported,
      ),
    'unsupported interactions reported without automatic denial',
  );
  assert(sharedApprovals.pending.has(unsupported));
  const untouched = sharedApprovals.add('external-approval-cli');
  await cliCommand(['stop', approvalSession.id]);
  assert(sharedApprovals.pending.has(untouched));
  for (const threadId of ['external-unloaded', 'external-foreign-approval']) {
    const session = JSON.parse(
      await cliCommand(['observe', threadId, '--project', 'test-project']),
    );
    await wait(
      () =>
        sharedApprovals.requests.some(
          (r) => r.method === 'thread/read' && r.threadId === threadId,
        ),
      'original approval scope verification',
    );
    assert(
      !sharedApprovals.requests.some(
        (r) => r.method === 'thread/resume' && r.threadId === threadId,
      ),
    );
    assert.equal(
      JSON.parse(await cliCommand(['approvals', session.id])).forwarding,
      false,
    );
    await cliCommand(['stop', session.id]);
  }
  pass(
    'original shared-server approval replay, CC explicit approval, per-turn permissions, deduplication, local resolution, project isolation and safe disconnect',
  );
  const largeSession = await api('/sessions', {
    hostId: enrolled.hostId,
    projectId: 'test-project',
    mode: 'web',
    threadId: 'large-history',
  });
  const hp = peer('/ws/v1/history/' + largeSession.id);
  await wait(
    () => hp.messages.some((m) => m.type === 'history-ready'),
    'read-only history connection',
  );
  const historyRead = async (data: Record<string, unknown>) => {
    const requestId = randomUUID();
    hp.send(JSON.stringify({ ...data, requestId }));
    await wait(
      () => hp.messages.some((m) => m.requestId === requestId),
      'history response',
    );
    const result = hp.messages.find((m) => m.requestId === requestId);
    assert(!result.error, JSON.stringify(result.error));
    return result;
  };
  const latestHistory = await historyRead({ operation: 'page', before: 0 });
  assert(latestHistory.events.length <= 200 && latestHistory.more);
  assert(Buffer.byteLength(JSON.stringify(latestHistory)) < 256 * 1024);
  const largeItem = latestHistory.events.find(
    (e: any) => e.contentSeq !== undefined,
  );
  assert(largeItem && largeItem.contentSeq < 0);
  const chunk = await historyRead({
    operation: 'content',
    seq: largeItem.contentSeq,
    revision: largeItem.revision,
  });
  assert(chunk.more && chunk.nextOffset === 4096 && !chunk.text.includes('�'));
  let before = latestHistory.cursor;
  for (let i = 0; i < 2; i++) {
    const page = await historyRead({ operation: 'page', before });
    assert(page.events.length > 0 && page.cursor < before && page.more);
    before = page.cursor;
  }
  // A reader neither owns the control lease nor prevents attaching an execution client.
  const controller = await web(largeSession.id);
  assert.equal(hp.ws.readyState, WebSocket.OPEN);
  await api(`/sessions/${largeSession.id}/stop`, {});
  const closedPage = await historyRead({ operation: 'page', before: 0 });
  assert(closedPage.events.length > 0);
  const closedOlder = await historyRead({ operation: 'page', before });
  assert(closedOlder.events.length > 0 && closedOlder.cursor < before);
  controller.ws.close();
  hp.ws.close();
  pass(
    'large Codex resume excludes full history, lazily pages items and chunks UTF-8 over bidirectional Worker WebSockets without acquiring control',
  );
  const key = randomUUID();
  const s = await api(
    '/sessions',
    { hostId: enrolled.hostId, projectId: 'test-project', mode: 'web' },
    { key },
  );
  assert.equal(
    (
      await api(
        '/sessions',
        { hostId: enrolled.hostId, projectId: 'test-project', mode: 'web' },
        { key },
      )
    ).id,
    s.id,
  );
  const cliDirectory = JSON.parse(
    await cliCommand(['sessions', '--host', 'local-test']),
  );
  assert(Array.isArray(cliDirectory.data));
  assert(cliDirectory.data.every((session: any) => session.mode === 'cli'));
  assert(!cliDirectory.data.some((session: any) => session.id === s.id));
  pass('Agent online, project allowlist and idempotent session creation');
  const legacyReceipt = await request(
    `/hosts/${enrolled.hostId}/requests/${key}`,
  );
  assert.equal(legacyReceipt.r.status, 404);
  const concurrentClaim = randomUUID();
  const tickets = await Promise.all([
    api(`/sessions/${s.id}/attach`, { claimId: concurrentClaim }),
    api(`/sessions/${s.id}/attach`, { claimId: concurrentClaim }),
  ]);
  const competitors = tickets.map(() => peer('/ws/v1/web/' + s.id));
  await Promise.all(
    competitors.map(
      (p) => new Promise<void>((resolve) => p.ws.once('open', resolve)),
    ),
  );
  competitors.forEach((p, i) =>
    p.send(JSON.stringify({ type: 'auth', ticket: tickets[i].ticket })),
  );
  await wait(
    () =>
      competitors.some((p) => p.messages.some((m) => m.type === 'attached')) &&
      competitors.some((p) => p.ws.readyState === WebSocket.CLOSED),
    'concurrent attach resolves',
  );
  assert.equal(
    competitors.filter((p) => p.messages.some((m) => m.type === 'attached'))
      .length,
    1,
  );
  let p = competitors.find((p) =>
    p.messages.some((m) => m.type === 'attached'),
  )!;
  await readyControl(p);
  pass('real DO concurrent attach permits exactly one controller');
  const modelsRequestId = randomUUID();
  p.send(JSON.stringify({ action: 'models', requestId: modelsRequestId }));
  await wait(
    () =>
      p.messages.some(
        (m) => m.type === 'ack' && m.requestId === modelsRequestId,
      ),
    'web model list',
  );
  assert.equal(
    p.messages.find((m) => m.type === 'ack' && m.requestId === modelsRequestId)
      .result.data[0].model,
    'test-model-alt',
  );
  const prompt = {
    action: 'prompt',
    requestId: randomUUID(),
    text: 'hello',
    model: 'test-model-alt',
  };
  p.send(JSON.stringify(prompt));
  await wait(
    () => p.messages.some((m) => m.event?.type === 'turn/completed'),
    'streamed turn',
  );
  const liveEvents = p.messages
    .filter((m) => m.type === 'event')
    .map((m) => m.event);
  assert.equal(
    liveEvents.find((e) => e.type === 'turn/started')?.data.model,
    'test-model-alt',
    'web model selection reaches Codex turn/start',
  );
  assert.deepEqual(
    liveEvents.map((e) => e.revision),
    liveEvents.map((e) => e.revision).sort((a, b) => a - b),
  );
  assert.equal(
    [...new Map(liveEvents.map((e) => [e.seq, e])).values()]
      .filter((e) => e.type === 'item/agentMessage/delta')
      .map((e) => e.data.delta)
      .join(''),
    'echo: hello',
  );
  const originalResults = () =>
    p.messages.filter(
      (m) =>
        m.type === 'delivery-result' &&
        JSON.parse(m.resultBody).requestId === prompt.requestId,
    );
  const resultAttempts = originalResults().length;
  p.send(JSON.stringify(prompt));
  await wait(
    () => originalResults().length > resultAttempts,
    'duplicate command returns its original result',
  );
  assert.equal(
    p.messages.filter(
      (m) => m.type === 'ack' && m.requestId === prompt.requestId,
    ).length,
    1,
    'Repeated original results produce one UI completion',
  );
  assert.equal(p.messages.filter((m) => m.event?.type === 'user').length, 1);
  pass('streaming and duplicate prompt suppression');
  p.send(JSON.stringify({ ...prompt, model: 'another-model' }));
  await wait(
    () =>
      p.messages.some(
        (m) => m.type === 'error' && m.requestId === prompt.requestId,
      ),
    'changed-model duplicate rejected',
  );
  assert.equal(
    p.messages.find(
      (m) => m.type === 'error' && m.requestId === prompt.requestId,
    ).error.code,
    'IDEMPOTENCY_CONFLICT',
  );
  pass(
    'web model discovery, turn model forwarding and model-aware duplicate rejection',
  );
  const expectedTakeoverEpoch =
    p.messages.find((m) => m.type === 'attached').control.controlEpoch + 1;
  const lostClaim = randomUUID();
  const lostTicket = await api(`/sessions/${s.id}/takeover`, {
    claimId: lostClaim,
  });
  const lostController = peer('/ws/v1/web/' + s.id);
  await new Promise<void>((done) => lostController.ws.once('open', done));
  agent.interruptNextReply();
  lostController.send(
    JSON.stringify({ type: 'auth', ticket: lostTicket.ticket }),
  );
  await wait(
    () => lostController.ws.readyState === WebSocket.CLOSED,
    'lost attach confirmation',
    // The lease deadline is 15 seconds; DO alarm delivery may run later under load.
    25000,
  );
  await wait(
    () => p.ws.readyState === WebSocket.CLOSED,
    'takeover reservation retires the old route before confirmation',
  );
  assert.equal(
    p.messages.filter(
      (m) => m.type === 'ack' && m.requestId === prompt.requestId,
    ).length,
    1,
  );
  await wait(
    async () => (await request(`/hosts/${enrolled.hostId}/probe`, {})).r.ok,
    'Agent reconnect after encrypted link loss',
    45000,
  );
  p = await web(s.id, true, lostClaim);
  assert.equal(
    p.messages.find((m) => m.type === 'attached').control.controlEpoch,
    expectedTakeoverEpoch,
  );
  pass(
    'lost takeover confirmation fences old writes and the same persisted claim resumes through Agent CONTROL_READY',
  );
  p.send(
    JSON.stringify({
      action: 'prompt',
      requestId: randomUUID(),
      text: 'approval',
    }),
  );
  await wait(
    () => p.messages.some((m) => m.event?.type === 'approval'),
    'approval request',
  );
  const approval = p.messages.find((m) => m.event?.type === 'approval').event
    .data;
  for (const invalid of [
    { runtimeId: randomUUID(), approvalVersion: approval.approvalVersion },
    { runtimeId: approval.runtimeId, approvalVersion: randomUUID() },
  ]) {
    const staleId = randomUUID();
    p.send(
      JSON.stringify({
        action: 'approval',
        requestId: staleId,
        approvalId: approval.approvalId,
        allow: true,
        ...invalid,
      }),
    );
    await wait(
      () =>
        p.messages.some(
          (m) =>
            m.type === 'error' &&
            m.requestId === staleId &&
            m.error?.code === 'STALE_APPROVAL',
        ),
      'stale approval rejected without resolving the original request',
    );
  }
  p.send(
    JSON.stringify({
      action: 'approval',
      requestId: randomUUID(),
      approvalId: approval.approvalId,
      runtimeId: approval.runtimeId,
      approvalVersion: approval.approvalVersion,
      allow: false,
    }),
  );
  await wait(
    () =>
      p.messages.some(
        (m) =>
          m.event?.type === 'item/agentMessage/delta' &&
          m.event.data.delta === 'denied',
      ),
    'approval rejected',
  );
  pass('bidirectional approval rejection');
  assert.equal((await request(`/sessions/${s.id}/attach`, {})).r.status, 409);
  const takeover = await api(`/sessions/${s.id}/takeover`, {});
  const q = peer('/ws/v1/web/' + s.id);
  await new Promise<void>((r) => q.ws.once('open', r));
  q.send(JSON.stringify({ type: 'auth', ticket: takeover.ticket }));
  await wait(() => q.messages.some((m) => m.type === 'attached'), 'takeover');
  await wait(
    () => p.ws.readyState === WebSocket.CLOSED,
    'old controller closed',
  );
  await readyControl(q);
  q.send(JSON.stringify({ action: 'sync', after: 0 }));
  await wait(() => q.messages.some((m) => m.type === 'sync'), 'history replay');
  assert(
    q.messages
      .find((m) => m.type === 'sync')
      .events.some((e: any) => e.type === 'user'),
  );
  pass('exclusive control, explicit takeover and persistent replay');
  const reused = peer('/ws/v1/web/' + s.id);
  await new Promise<void>((r) => reused.ws.once('open', r));
  reused.send(JSON.stringify({ type: 'auth', ticket: takeover.ticket }));
  await wait(
    () => reused.ws.readyState === WebSocket.CLOSED,
    'ticket replay rejected',
  );
  pass('connection ticket cannot be reused');
  await api(`/sessions/${s.id}/stop`, {});
  token = clientCredentials.token;
  const cli = await api('/sessions', {
    hostId: enrolled.hostId,
    projectId: 'test-project',
    mode: 'cli',
  });
  const ticket = await api(`/sessions/${cli.id}/attach`, {});
  const cp = peer('/ws/v1/cli/' + cli.id, ticket.ticket);
  await new Promise<void>((r, j) => {
    cp.ws.once('open', r);
    cp.ws.once('error', j);
  });
  await readyControl(cp);
  cp.send(
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'test', version: '1' } },
    }),
  );
  await wait(() => cp.messages.some((m) => m.id === 1 && m.result), 'CLI init');
  cp.send(JSON.stringify({ id: 2, method: 'thread/start', params: {} }));
  await wait(
    () => cp.messages.some((m) => m.id === 2 && m.result),
    'CLI thread',
  );
  cp.send(JSON.stringify({ id: 3, method: 'config/value/write', params: {} }));
  await wait(
    () => cp.messages.some((m) => m.id === 3 && m.error),
    'CLI prohibited method',
  );
  assert(!cp.messages.some((m) => m.id === 3 && m.result));
  pass('CLI command windows, read routing and unsafe RPC rejection');
  const cliThread = cp.messages.find((m) => m.id === 2).result.thread.id;
  cp.send(
    JSON.stringify({
      id: 4,
      method: 'turn/start',
      params: {
        threadId: cliThread,
        input: [{ type: 'text', text: 'local cache test' }],
      },
    }),
  );
  await wait(
    () => cp.messages.some((m) => m.method === 'turn/completed'),
    'CLI history source',
  );
  const cachedCli = JSON.parse(await cliCommand(['history', cli.id]));
  assert(
    cachedCli.events.some(
      (e: any) => e.type === 'user' && e.data.text === 'local cache test',
    ),
  );
  const offlineCli = JSON.parse(
    await cliCommand(['history', cli.id, '--offline', 'true']),
  );
  assert.deepEqual(offlineCli.events, cachedCli.events);
  assert.equal(statSync(join(dir, 'client-history')).isDirectory(), true);
  pass(
    'CC fetches history over Worker WebSocket and persists scoped SQLite pages for offline reads',
  );

  await cliCommand(['stop', cli.id]);
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  symlinkSync(resolve('tests/fixtures/fake-tui.mjs'), join(binDir, 'codex'));
  const capture = join(dir, 'tui-launch.json');
  const output = await cliCommand(
    ['connect', '--host', 'local-test', '--project', 'test-project'],
    '',
    {
      PATH: binDir + ':' + process.env.PATH,
      COC_TUI_CAPTURE: capture,
    },
  );
  const launched = JSON.parse(readFileSync(capture, 'utf8'));
  assert.equal(launched.args[0], '--remote');
  assert(
    new URL(launched.args[1]).hostname === '127.0.0.1' &&
      new URL(launched.args[1]).pathname === '/',
  );
  assert.equal(launched.args[2], '--remote-auth-token-env');
  assert.equal(launched.args[3], 'COC_REMOTE_TICKET');
  assert(launched.ticket.length > 20);
  assert(!launched.args.includes(launched.ticket));
  assert(launched.args.includes('workspace-write'));
  const launchId = output.match(/Remote session: ([a-zA-Z0-9_~-]+)/)![1];
  await cliCommand(['stop', launchId]);
  pass(
    'C++ CLI connects and launches TUI with policy and ticket via environment',
  );
  const recoveryCapture = join(dir, 'tui-recovery.json');
  const recoveryGate = join(dir, 'tui-recovery-gate');
  const priorReplyInterrupts = agent.interruptedReplies;
  agent.interruptNextReply();
  const recoveryCreateId = randomUUID();
  const recoverOriginalCreate = () =>
    cliCommand(
      [
        'connect',
        '--host',
        'local-test',
        '--project',
        'test-project',
        '--request-id',
        recoveryCreateId,
      ],
      '',
      {
        PATH: binDir + ':' + process.env.PATH,
        COC_TUI_CAPTURE: recoveryCapture,
        COC_TUI_RELIABLE_GATE: recoveryGate,
      },
    );
  const recoveringCli = (async () => {
    try {
      return await recoverOriginalCreate();
    } catch (error) {
      // The Agent now waits 30 seconds after a lost channel. An unconfigured
      // wake endpoint leaves the original intent for explicit client recovery.
      if (!String(error).includes('HOST_OFFLINE')) throw error;
      await wait(
        async () => (await request(`/hosts/${enrolled.hostId}/probe`, {})).r.ok,
        'Agent recovers before the same CLI original request is retried',
        45000,
      );
      return recoverOriginalCreate();
    }
  })();
  void recoveringCli.catch(() => {});
  await wait(
    () =>
      existsSync(recoveryCapture) &&
      JSON.parse(readFileSync(recoveryCapture, 'utf8')).phase === 'connected',
    'reliable TUI attached',
    60000,
  );
  assert.equal(
    agent.interruptedReplies,
    priorReplyInterrupts + 1,
    'real CLI recovered an interrupted encrypted reply',
  );
  const interruptedTransport = agent.socket;
  interruptedTransport?.close(1012);
  await wait(
    () =>
      agent!.socket !== interruptedTransport &&
      agent!.socket?.readyState === WebSocket.OPEN,
    'Agent replaces the interrupted transport after its retry delay',
    45000,
  );
  await wait(
    async () =>
      (await api('/hosts')).some(
        (host: any) => host.id === enrolled.hostId && host.online,
      ),
    'Agent recovered for the original TUI',
    45000,
  );
  agent.interruptNextReply();
  writeFileSync(recoveryGate, 'continue');
  const recoveryOutput = await recoveringCli;
  const recoveredTui = JSON.parse(readFileSync(recoveryCapture, 'utf8'));
  assert.equal(recoveredTui.completed, 4);
  assert.equal(recoveredTui.largeResultBytes, 300000);
  const recoverySession = recoveryOutput.match(
    /Remote session: ([a-zA-Z0-9_~-]+)/,
  )![1];
  await cliCommand(['stop', recoverySession]);
  pass(
    'reliable CC keeps its local TUI through interrupted encrypted records and reconnect, interrupts its exact CLI task and verifies a 300 KB transfer result',
  );
  // Real browser uses the same cookie/Origin path as users; no bearer bypass.
  browser = await chromium.launch({
    headless: true,
    ...(process.env.COC_BROWSER_PATH
      ? { executablePath: process.env.COC_BROWSER_PATH }
      : {}),
  });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await page.getByLabel('所有者密钥').fill(secret);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page
    .getByRole('heading', { name: '待授权请求', exact: true })
    .waitFor();
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /API Key 管理访问/ }).click();
  // API keys are credentials themselves; no browser pairing or token exchange.
  await page.getByLabel('Key 名称').fill('e2e-agent-key');
  await page.getByRole('button', { name: '生成 API_KEY', exact: true }).click();
  await page.getByLabel('新 API_KEY').waitFor();
  const agentKey = await page.getByLabel('新 API_KEY').inputValue();
  const keyAgentFile = join(dir, 'key-agent.json');
  const agentOutput = await cliCommand(
    [
      'login',
      '--relay',
      origin,
      '--api-key',
      '--config',
      keyAgentFile,
      '--project',
      dir,
    ],
    '',
    { COC_API_KEY: agentKey },
    process.env.COC_AGENT_BINARY || 'build/coc-agent',
  );
  assert(!agentOutput.includes('#authorize='));
  assert(!agentOutput.includes(agentKey));
  const keyAgentConfig = JSON.parse(readFileSync(keyAgentFile, 'utf8'));
  assert.equal(keyAgentConfig.token, agentKey);
  const keyAgentFile2 = join(dir, 'key-agent-2.json');
  await cliCommand(
    [
      'login',
      '--relay',
      origin,
      '--api-key',
      '--config',
      keyAgentFile2,
      '--project',
      dir,
    ],
    agentKey + '\n',
    {},
    process.env.COC_AGENT_BINARY || 'build/coc-agent',
  );
  assert.equal(
    JSON.parse(readFileSync(keyAgentFile2, 'utf8')).hostId,
    keyAgentConfig.hostId,
  );
  await cliCommand(
    ['status', '--config', keyAgentFile],
    '',
    {},
    process.env.COC_AGENT_BINARY || 'build/coc-agent',
  );
  await page.getByRole('button', { name: '隐藏 API_KEY', exact: true }).click();
  await page.getByLabel('Key 名称').fill('e2e-client-key');
  await page.getByLabel('使用程序').selectOption('cli');
  await page.getByLabel('Key 目标 A').selectOption(enrolled.hostId);
  await page.getByRole('button', { name: '生成 API_KEY', exact: true }).click();
  await page.getByLabel('新 API_KEY').waitFor();
  const clientKey = await page.getByLabel('新 API_KEY').inputValue();
  const keyClientFile = join(dir, 'key-client.json');
  const clientOutput = await cliCommand(
    [
      'login',
      '--api-key',
      '--relay',
      origin,
      '--host',
      enrolled.hostId,
      '--config',
      keyClientFile,
    ],
    clientKey + '\n',
  );
  assert(!clientOutput.includes('#authorize='));
  assert(!clientOutput.includes(clientKey));
  assert.equal(
    JSON.parse(readFileSync(keyClientFile, 'utf8')).entries[0].token,
    clientKey,
  );
  await cliCommand(['projects', '--config', keyClientFile]);
  assert.equal(statSync(keyClientFile).mode & 0o777, 0o600);
  const priorToken = token;
  token = clientKey;
  const keySession = await api('/sessions', {
    hostId: enrolled.hostId,
    projectId: 'test-project',
    mode: 'cli',
  });
  const keyTicket = await api('/sessions/' + keySession.id + '/attach', {});
  const keyPeer = peer('/ws/v1/cli/' + keySession.id, keyTicket.ticket);
  await new Promise<void>((r, j) => {
    keyPeer.ws.once('open', r);
    keyPeer.ws.once('error', j);
  });
  page.once('dialog', (d) => void d.accept());
  await page
    .getByRole('button', { name: '撤销 Key e2e-client-key', exact: true })
    .click();
  await wait(
    () => keyPeer.ws.readyState === WebSocket.CLOSED,
    'API key revocation closes CC socket',
  );
  assert.equal(keyPeer.closeCode, 4001);
  assert.equal((await request('/hosts')).r.status, 401);
  token = priorToken;
  const agentKeyPeer = peer('/ws/v1/agent', agentKey);
  await new Promise<void>((r, j) => {
    agentKeyPeer.ws.once('open', r);
    agentKeyPeer.ws.once('error', j);
  });
  page.once('dialog', (d) => void d.accept());
  await page
    .getByRole('button', { name: '撤销 Key e2e-agent-key', exact: true })
    .click();
  await wait(
    () => agentKeyPeer.ws.readyState === WebSocket.CLOSED,
    'API key revocation closes A socket',
  );
  assert.equal(agentKeyPeer.closeCode, 4001);
  mkdirSync(artifacts, { recursive: true });
  await page.screenshot({
    path: join(artifacts, 'api-key-management.png'),
    fullPage: true,
  });
  pass(
    'web role/host scoped key generation, native A/CC direct-key login, immutable A binding and immediate live revocation',
  );
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /设备授权 审批/ }).click();
  const pairedCliFile = join(dir, 'ui-paired-client.json');
  await cliCommand(
    [
      'login',
      '--relay',
      origin,
      '--config',
      pairedCliFile,
      '--name',
      'UI paired CLI',
      '--message',
      '请管理员选择开发服务器',
    ],
    '',
    {},
    undefined,
    { hostId: enrolled.hostId, message: '请管理员选择开发服务器', page },
  );
  const pairedCli = JSON.parse(readFileSync(pairedCliFile, 'utf8'));
  assert.equal(pairedCli.entries[0].hostId, enrolled.hostId);
  assert.equal(pairedCli.entries[0].role, 'cli');
  assert.equal(statSync(pairedCliFile).mode & 0o777, 0o600);
  pass(
    'CC paired login without host sends a message and persists the administrator UI-selected server',
  );
  const targetedBrowser = await browser.newContext({
    extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.24' },
  });
  const targetedPage = await targetedBrowser.newPage();
  await targetedPage.goto(origin);
  await targetedPage.getByLabel('设备名称').fill('Agent targeted CW');
  await targetedPage.getByLabel('目标服务器 ID（选填）').fill(enrolled.hostId);
  await targetedPage
    .getByLabel('给管理员留言')
    .fill('请目标 Agent 批准网页访问');
  await targetedPage
    .getByRole('button', { name: '申请登录', exact: true })
    .click();
  const targetedCode = await targetedPage
    .locator('.login-card strong')
    .innerText();
  await page
    .getByLabel('目标服务器 ' + targetedCode, { exact: true })
    .waitFor();
  assert(
    await page
      .getByLabel('目标服务器 ' + targetedCode, { exact: true })
      .isDisabled(),
  );
  assert.equal(
    await page
      .getByLabel('目标服务器 ' + targetedCode, { exact: true })
      .inputValue(),
    enrolled.hostId,
  );
  await targetedPage.screenshot({
    path: join(artifacts, 'cw-agent-approval-request.png'),
    fullPage: true,
  });
  const agentBinary = process.env.COC_AGENT_BINARY || 'build/coc-agent';
  const agentRequests = () =>
    cliCommand(['requests', '--config', configFile], '', {}, agentBinary).then(
      JSON.parse,
    );
  const targetedRequest = (await agentRequests()).pending.find(
    (request: any) => request.code === targetedCode,
  );
  assert(targetedRequest && targetedRequest.role === 'web');
  await wait(
    () => approvalNotices(agent!).some((n) => n.id === targetedRequest.id),
    'running Agent reports newly arrived CW request',
    40000,
  );
  assert.equal(
    approvalNotices(agent!).filter((n) => n.id === startupRequest.id).length,
    1,
  );
  pass(
    'running Agents discover new requests, deduplicate notices and recover from approval service failure',
  );
  await cliCommand(
    ['approve', targetedRequest.id, '--config', configFile],
    '',
    {},
    agentBinary,
  );
  await targetedPage.locator('.chat-workspace').waitFor();
  const targetedCookie = (await targetedBrowser.cookies()).find(
    (c) => c.name === 'coc_web_' + enrolled.hostId,
  );
  assert(targetedCookie?.httpOnly);
  assert.equal((await agentRequests()).pending.length, 0);
  await targetedPage.reload();
  await targetedPage.locator('.chat-workspace').waitFor();
  const rejectedBrowser = await browser.newContext({
    extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.25' },
  });
  const rejectedPage = await rejectedBrowser.newPage();
  await rejectedPage.goto(origin);
  await rejectedPage.getByLabel('目标服务器 ID（选填）').fill(enrolled.hostId);
  await rejectedPage
    .getByRole('button', { name: '申请登录', exact: true })
    .click();
  const rejectedCode = await rejectedPage
    .locator('.login-card strong')
    .innerText();
  const rejectedRequest = (await agentRequests()).pending.find(
    (request: any) => request.code === rejectedCode,
  );
  assert(rejectedRequest);
  await cliCommand(
    ['reject', rejectedRequest.id, '--config', configFile],
    '',
    {},
    agentBinary,
  );
  await rejectedPage
    .getByRole('alert')
    .filter({ hasText: '目标服务器或管理员已拒绝登录申请' })
    .waitFor();
  assert(
    !(await rejectedBrowser.cookies()).some((c) =>
      c.name.startsWith('coc_web_'),
    ),
  );
  await targetedBrowser.close();
  await rejectedBrowser.close();
  pass(
    'CW explicit target is immutable in administrator UI; native Agent approves/rejects while running and scoped cookie survives reload',
  );
  // Give this simulated browser its own IP rate budget, separate from native setup.
  const visitor = await browser.newContext({
    extraHTTPHeaders: { 'CF-Connecting-IP': '192.0.2.20' },
  });
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(origin);
  assert.equal(await visitorPage.getByLabel('服务器标识').count(), 0);
  const browserMessage =
    '我是测试用户，请授权开发服务器。\n用途：验证 <script>alert(1)</script> 留言按文本显示。';
  await visitorPage.getByLabel('给管理员留言').fill(browserMessage);
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-request-message.png'),
    fullPage: true,
  });
  await visitorPage
    .getByRole('button', { name: '申请登录', exact: true })
    .click();
  const pending = await visitorPage.locator('strong').innerText();
  const requestRow = page
    .getByRole('row')
    .filter({
      has: page.getByRole('button', { name: '批准 ' + pending, exact: true }),
    })
    .last();
  await requestRow.getByText(browserMessage, { exact: true }).waitFor();
  assert(
    await requestRow
      .getByRole('button', { name: '批准 ' + pending, exact: true })
      .isDisabled(),
  );
  await page
    .getByLabel('目标服务器 ' + pending, { exact: true })
    .selectOption(enrolled.hostId);
  await page.screenshot({
    path: join(artifacts, 'cw-admin-select-server.png'),
    fullPage: true,
  });
  await page
    .getByRole('button', { name: '批准 ' + pending, exact: true })
    .click();
  await visitorPage.locator('.chat-workspace').waitFor();
  await feature(visitorPage, /^会话记录/);
  await visitorPage.getByLabel('主机').waitFor();
  assert.equal(
    await visitorPage
      .getByRole('heading', { name: '待授权请求', exact: true })
      .count(),
    0,
  );
  const browserCookies = await visitor.cookies();
  const webCookie = browserCookies.find(
    (c) => c.name === 'coc_web_' + enrolled.hostId,
  )!;
  assert(webCookie.httpOnly);
  assert(webCookie.expires * 1000 > Date.now() + 300 * 86400000);
  // Save another A credential in the same browser, then switch back to the online A.
  await feature(visitorPage, /^会话记录/);
  await visitorPage.getByRole('button', { name: '添加 A 授权' }).click();
  await visitorPage.getByLabel('给管理员留言').fill('请再授权第二台服务器');
  await visitorPage
    .getByRole('button', { name: '申请登录', exact: true })
    .click();
  const secondCode = await visitorPage.locator('strong').innerText();
  await page
    .getByLabel('目标服务器 ' + secondCode, { exact: true })
    .selectOption(other.hostId);
  await page
    .getByRole('button', { name: '批准 ' + secondCode, exact: true })
    .click();
  await wait(
    async () =>
      (await visitor.cookies()).filter((c) => c.name.startsWith('coc_web_'))
        .length === 2,
    'two browser credentials',
  );
  await visitorPage.reload();
  await visitorPage.locator('.chat-workspace').waitFor();
  await feature(visitorPage, /^会话记录/);
  await visitorPage.getByLabel('主机').waitFor();
  assert.equal(
    await visitorPage.getByLabel('主机').locator('option').count(),
    3,
  );
  await visitorPage.screenshot({
    path: process.env.COC_LOGIN_SCREENSHOT_PATH || join(dir, 'login-link.png'),
    fullPage: true,
  });

  pass(
    'administrator approves browser requests; two scoped persistent cookies survive reload',
  );
  await browserSessionStress({
    browser,
    origin,
    hostId: enrolled.hostId,
    projectId: 'test-project',
    cookies: await visitor.cookies(),
    artifacts,
  });
  // Different tabs select their own host cookie; the selected identity is not global.
  const otherPage = await visitor.newPage();
  await otherPage.goto(origin);
  await feature(otherPage, /^会话记录/);
  await otherPage.getByLabel('主机').selectOption(other.hostId);
  await wait(
    async () =>
      (await otherPage.getByLabel('项目').inputValue()) === 'other-project',
    'other A project selection',
  );
  await feature(otherPage, /^新建对话/);
  await idle(otherPage);
  await otherPage.getByLabel('任务内容').fill('other host');
  await otherPage.getByRole('button', { name: '发送', exact: true }).click();
  await otherPage.getByText('echo: other host', { exact: true }).waitFor();
  await feature(visitorPage, /^会话记录/);
  await visitorPage.getByLabel('主机').selectOption(enrolled.hostId);
  await visitorPage.getByRole('button', { name: '创建网页会话' }).click();
  await idle(visitorPage);
  agent.interruptNextRequest();
  await visitorPage.getByLabel('任务内容').fill('browser hello');
  await visitorPage.getByRole('button', { name: '发送', exact: true }).click();
  await wait(
    async () =>
      agent!.requestPaused &&
      (await visitorPage.getByLabel('任务内容').inputValue()) === '',
    'browser persisted its command before the encrypted link interruption',
  );
  agent.releaseInterruptedRequest();
  await visitorPage
    .getByText('echo: browser hello', { exact: true })
    .waitFor({ timeout: 90000 });
  await idle(visitorPage);
  agent.interruptReplyWhen(() => true);
  await visitorPage.getByLabel('任务内容').fill('hello 你好，世界！');
  await visitorPage.getByRole('button', { name: '发送', exact: true }).click();
  await wait(
    async () =>
      agent!.replyPaused &&
      (await visitorPage.getByLabel('任务内容').inputValue()) === '',
    'browser persists the prompt before the opaque reply link is closed',
  );
  agent.releaseInterruptedReply();
  await visitorPage
    .getByText('echo: hello 你好，世界！', { exact: true })
    .waitFor({ timeout: 90000 });
  await idle(visitorPage);
  if (process.env.COC_TEST_TERMINAL === '1') {
    // The preceding forced disconnect can leave its dismissible error banner.
    // Restore the normal viewport budget before asserting 48px of resize room.
    const offlineNotice = visitorPage
      .locator('.chat-workspace > .error')
      .filter({ hasText: 'HOST_OFFLINE' });
    if (await offlineNotice.isVisible())
      await offlineNotice
        .getByRole('button', { name: '关闭', exact: true })
        .click();
    await visitorPage
      .getByRole('button', { name: '功能菜单', exact: true })
      .click();
    await visitorPage
      .locator('.workbench-menu-items')
      .getByRole('button', { name: 'Terminal', exact: true })
      .click();
    const terminalRequests: string[] = [];
    visitorPage.on('request', (req) => {
      if (new URL(req.url()).pathname.endsWith('/terminal'))
        terminalRequests.push(req.method());
    });
    const terminal = visitorPage.getByLabel('Terminal', { exact: true });
    await expect(
      terminal.getByRole('button', { name: '打开终端' }),
    ).toBeEnabled();
    visitorPage.once('dialog', (dialog) => void dialog.accept());
    await terminal.getByRole('button', { name: '打开终端' }).click();
    await expect(terminal.getByRole('heading')).toContainText('已连接', {
      timeout: 15000,
    });
    await expect(terminal.getByRole('heading')).toContainText('已连接');
    await terminal.locator('.xterm-helper-textarea').focus();
    const echoStarted = performance.now();
    await visitorPage.keyboard.type("printf 'BROWSER_%s\\n' TERMINAL_OK");
    await visitorPage.keyboard.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText(
      'BROWSER_TERMINAL_OK',
      { timeout: 15000 },
    );
    console.log(
      'Streaming Terminal command echo ms:',
      Math.round(performance.now() - echoStarted),
    );
    assert(
      terminalRequests.length === 0,
      'Terminal byte traffic uses the stream, not HTTP polling',
    );
    await visitorPage.screenshot({
      path: join(artifacts, 'interactive-terminal.png'),
    });
    const terminalLayout = await visitorPage.evaluate(() => ({
      terminalTop: document
        .querySelector('.interactive-terminal')!
        .getBoundingClientRect().top,
      composerBottom: document
        .querySelector('.composer')!
        .getBoundingClientRect().bottom,
    }));
    assert(
      terminalLayout.terminalTop >= terminalLayout.composerBottom,
      JSON.stringify(terminalLayout),
    );
    const terminalHeightBefore = (await terminal.boundingBox())!.height;
    const terminalHandle = visitorPage.getByRole('separator', {
      name: '调整 Terminal 高度',
      exact: true,
    });
    const handleBounds = (await terminalHandle.boundingBox())!;
    await visitorPage.mouse.move(
      handleBounds.x + handleBounds.width / 2,
      handleBounds.y + handleBounds.height / 2,
    );
    await visitorPage.mouse.down();
    await visitorPage.mouse.move(
      handleBounds.x + handleBounds.width / 2,
      handleBounds.y + handleBounds.height / 2 - 48,
      { steps: 6 },
    );
    await visitorPage.mouse.up();
    assert((await terminal.boundingBox())!.height > terminalHeightBefore + 32);
    await expect(terminal.locator('.xterm-rows')).toContainText(
      'BROWSER_TERMINAL_OK',
    );
    const splitTerminalHeight = (await terminal.boundingBox())!.height;
    const terminalElement = await terminal.elementHandle();
    await terminal.getByRole('button', { name: '全屏', exact: true }).click();
    await expect(
      terminal.getByRole('button', { name: '退出全屏', exact: true }),
    ).toBeVisible();
    assert.equal(
      (await terminal.boundingBox())!.height,
      visitorPage.viewportSize()!.height,
    );
    await expect(terminal.getByRole('heading')).toContainText('已连接');
    await terminal.locator('.xterm-helper-textarea').focus();
    await visitorPage.keyboard.type("printf 'FULLSCREEN_%s\\n' TERMINAL_OK");
    await visitorPage.keyboard.press('Enter');
    await expect(terminal.locator('.xterm-rows')).toContainText(
      'FULLSCREEN_TERMINAL_OK',
    );
    await visitorPage.keyboard.press('Escape');
    await expect(
      terminal.getByRole('button', { name: '全屏', exact: true }),
    ).toBeVisible();
    assert.equal((await terminal.boundingBox())!.height, splitTerminalHeight);
    assert(
      await terminalElement!.evaluate(
        (node) => node === document.querySelector('.interactive-terminal'),
      ),
      'fullscreen preserves terminal DOM',
    );
    await expect(terminal.getByRole('heading')).toContainText('已连接');
    const terminalViewport = visitorPage.viewportSize()!;
    await visitorPage.setViewportSize({ width: 390, height: 480 });
    await expect(
      terminal.getByRole('button', { name: '终止终端' }),
    ).toBeVisible();
    assert(
      await visitorPage.evaluate(
        () =>
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight,
      ),
    );
    await visitorPage.screenshot({
      path: join(artifacts, 'interactive-terminal-mobile.png'),
    });
    await visitorPage.setViewportSize(terminalViewport);
    visitorPage.once('dialog', (dialog) => void dialog.accept());
    await terminal.getByRole('button', { name: '终止终端' }).click();
    await expect(
      terminal.getByRole('button', { name: '打开终端' }),
    ).toBeEnabled();
    await terminal.getByRole('button', { name: '收起' }).click();
    pass(
      'Chromium to Worker to native sandboxed PTY input/output and explicit close',
    );
  }
  const browserSession = await sessionId(visitorPage);
  let interruptChannel = false;
  let controlConnections = 0;
  await visitorPage.routeWebSocket('**/ws/v1/channel/**', (route) => {
    controlConnections++;
    const upstream = route.connectToServer();
    route.onMessage((message) => {
      if (
        interruptChannel &&
        JSON.parse(String(message)).type === 'channel-data'
      ) {
        interruptChannel = false;
        route.close({ code: 1012, reason: 'Encrypted link interrupted' });
        return;
      }
      upstream.send(message);
    });
  });
  await visitorPage.reload();
  await feature(visitorPage, /^会话记录/);
  await visitorPage.getByLabel('主机').selectOption(enrolled.hostId);
  await feature(visitorPage, /^会话记录/);
  await visitorPage
    .getByRole('button', { name: /browser hello/ })
    .first()
    .click();
  assert.equal(await sessionId(visitorPage), browserSession);
  await visitorPage
    .getByText('echo: browser hello', { exact: true })
    .waitFor({ timeout: 90000 });
  await visitorPage
    .getByText('echo: hello 你好，世界！', { exact: true })
    .waitFor({ timeout: 90000 });
  await idle(visitorPage);
  pass(
    'character-by-character English/Chinese streaming and ordered history after browser reload',
  );
  const stableControllerCount = controlConnections;
  interruptChannel = true;
  await visitorPage.getByLabel('任务内容').fill('stalled-channel-proof');
  await visitorPage.getByRole('button', { name: '发送', exact: true }).click();
  await visitorPage
    .getByText('echo: stalled-channel-proof', { exact: true })
    .waitFor({ timeout: 30000 });
  await idle(visitorPage);
  await visitorPage
    .getByRole('button', { name: '刷新状态', exact: true })
    .click();
  await wait(
    () =>
      visitorPage
        .getByRole('button', { name: '刷新状态', exact: true })
        .isEnabled(),
    'independent reliable snapshot',
  );
  assert(
    controlConnections > stableControllerCount,
    'interrupted physical channel is replaced',
  );
  await expect(
    visitorPage.getByText('stalled-channel-proof', { exact: true }),
  ).toHaveCount(1);

  pass(
    'CW restores encrypted physical channels and recovers the same command without duplicate user messages',
  );
  const cacheSize = await visitorPage.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('coc-history-v3');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise<number>((resolve) => {
      const request = db.transaction('events').objectStore('events').count();
      request.onsuccess = () => {
        db.close();
        resolve(request.result);
      };
    });
  });
  assert(cacheSize > 0);
  let historyOffline = true;
  await visitorPage.routeWebSocket('**/ws/v1/channel/**', (route) => {
    if (historyOffline)
      route.close({ code: 1013, reason: 'Test Agent offline' });
    else route.connectToServer();
  });
  await visitorPage.reload();
  await feature(visitorPage, /^会话记录/);
  await visitorPage.getByLabel('主机').selectOption(enrolled.hostId);
  await feature(visitorPage, /^会话记录/);
  await visitorPage
    .getByRole('button', { name: /browser hello/ })
    .first()
    .click();
  await visitorPage
    .getByText('echo: browser hello', { exact: true })
    .waitFor({ timeout: 90000 });
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-history-cache.png'),
    fullPage: true,
  });
  historyOffline = false;

  pass(
    'CW persists IndexedDB history and restores cached host/session catalog when Agent metadata is unavailable',
  );

  await visitorPage.screenshot({
    path: process.env.COC_SCREENSHOT_PATH || join(dir, 'browser.png'),
    fullPage: true,
  });
  pass(
    'browser cookie login, project selection, task submission and streaming',
  );
  await feature(visitorPage, /^会话记录/);
  await visitorPage
    .getByRole('button', { name: '刷新会话', exact: true })
    .click();
  await visitorPage
    .getByRole('button', { name: '恢复并继续：外部运行会话', exact: true })
    .click();
  await visitorPage.getByRole('dialog').waitFor({ state: 'hidden' });
  await visitorPage
    .getByText(/外部会话 · 只读同步/)
    .first()
    .waitFor();
  const queuedButton = visitorPage.getByRole('button', {
    name: '加入队列',
    exact: true,
  });
  await visitorPage
    .getByRole('textbox', { name: '任务内容' })
    .fill('browser external queued input');
  await queuedButton.click();
  await visitorPage
    .getByText('已加入原客户端队列，等待原客户端执行；审批仍在原客户端处理。')
    .waitFor();
  assert.equal(
    await visitorPage
      .getByRole('button', { name: '停止本轮', exact: true })
      .count(),
    0,
  );
  await visitorPage.screenshot({
    path: join(artifacts, 'external-session-queue.png'),
    fullPage: true,
  });
  await visitorPage
    .locator('.notice')
    .filter({ hasText: '已加入原客户端队列，等待原客户端执行' })
    .getByRole('button', { name: '关闭', exact: true })
    .click();
  const browserApproval = sharedApprovals.add(
    'external-history',
    'item/fileChange/requestApproval',
  );
  await visitorPage.getByRole('region', { name: '待确认请求' }).waitFor();
  await visitorPage
    .locator('.approval-queue details')
    .filter({ hasText: 'remote-approval.txt' })
    .locator('summary')
    .click();
  await visitorPage
    .getByText('+remote approval patch preview', { exact: true })
    .waitFor();
  await visitorPage.screenshot({
    path: join(artifacts, 'external-approval.png'),
    fullPage: true,
  });
  await visitorPage.getByRole('button', { name: '拒绝', exact: true }).click();
  await wait(
    () => sharedApprovals.decisions.has(browserApproval),
    'CW remote file approval',
  );
  assert.deepEqual(sharedApprovals.decisions.get(browserApproval), {
    decision: 'decline',
  });
  await visitorPage
    .getByRole('region', { name: '待确认请求' })
    .waitFor({ state: 'hidden' });
  const autoApprove = visitorPage.getByRole('checkbox', {
    name: '自动批准当前会话',
    exact: true,
  });
  assert.equal(await autoApprove.isChecked(), false);
  await autoApprove.click();
  await wait(
    async () =>
      (await autoApprove.isChecked()) && (await autoApprove.isEnabled()),
    'Agent policy confirmed',
  );
  const automaticRequests = [
    sharedApprovals.add('external-history'),
    sharedApprovals.add('external-history', 'item/fileChange/requestApproval'),
    sharedApprovals.add('external-history', 'item/permissions/requestApproval'),
  ];
  await wait(
    () => automaticRequests.every((id) => sharedApprovals.decisions.has(id)),
    'CW automatic command, file and per-turn permission decisions',
  );
  for (const id of automaticRequests.slice(0, 2))
    assert.deepEqual(sharedApprovals.decisions.get(id), { decision: 'accept' });
  assert.deepEqual(sharedApprovals.decisions.get(automaticRequests[2]), {
    permissions: { network: { enabled: true } },
    scope: 'turn',
  });
  await visitorPage.locator('.auto-approval summary').click();
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-auto-approval-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await visitorPage.locator('.auto-approval summary').click();
  pass(
    'CW explicit opt-in automatically answers command, file and turn permission approvals through the original server',
  );
  const autoSessionToken = token;
  token = '';
  const autoSession = (await api('/sessions?hostId=' + enrolled.hostId)).find(
    (s: any) => s.external && s.state === 'ready',
  );
  token = autoSessionToken;
  assert.equal(autoSession.autoApproval, true);
  await visitorPage.goto('about:blank');
  const unattended = sharedApprovals.add(
    'external-history',
    'item/fileChange/requestApproval',
  );
  await wait(
    () => sharedApprovals.decisions.has(unattended),
    'Agent approves after the CW page is closed',
  );
  assert.deepEqual(sharedApprovals.decisions.get(unattended), {
    decision: 'accept',
  });
  await visitorPage.goto(origin);
  const restoredPolicy = visitorPage.getByRole('checkbox', {
    name: '自动批准当前会话',
    exact: true,
  });
  await wait(
    async () => await restoredPolicy.isChecked(),
    'reopen restores the Agent policy',
  );
  await restoredPolicy.click();
  await wait(
    async () =>
      !(await restoredPolicy.isChecked()) && (await restoredPolicy.isEnabled()),
    'Agent policy disabled',
  );
  const manualOnly = sharedApprovals.add(
    'external-history',
    'item/fileChange/requestApproval',
  );
  await visitorPage.getByRole('region', { name: '待确认请求' }).waitFor();
  assert.equal(
    sharedApprovals.decisions.has(manualOnly),
    false,
    'disabled Agent policy leaves new approvals pending',
  );
  await visitorPage.getByRole('button', { name: '拒绝', exact: true }).click();
  await wait(
    () => sharedApprovals.decisions.has(manualOnly),
    'manual approval remains available after disabling',
  );
  pass(
    'Agent session policy persists across page closure, continues approvals and restores on reopen; disabling leaves new requests manual',
  );
  if (await visitorPage.locator('.notice').isVisible())
    await visitorPage
      .locator('.notice')
      .getByRole('button', { name: '关闭', exact: true })
      .click();
  const beforeExternalToken = token;
  token = '';
  const browserExternal = (
    await api('/sessions?hostId=' + enrolled.hostId)
  ).find((s: any) => s.external && s.state === 'ready');
  await api(`/sessions/${browserExternal.id}/stop`, {});
  token = beforeExternalToken;
  await feature(visitorPage, /^会话记录/);
  await visitorPage.getByRole('button', { name: /本地历史对话/ }).click();
  await visitorPage.getByRole('dialog').waitFor({ state: 'hidden' });
  await visitorPage.getByRole('heading', { name: 'Restored reply' }).waitFor();
  assert.equal(
    await visitorPage
      .getByRole('checkbox', { name: '自动批准当前会话', exact: true })
      .isChecked(),
    false,
    'switching sessions resets automatic approval',
  );
  assert.equal(await visitorPage.locator('.markdown table').count(), 1);
  assert.equal(
    await visitorPage.locator('.markdown pre code').innerText(),
    'const restored = true;\n',
  );
  assert.equal(
    await visitorPage.locator('.markdown a[href^="javascript:"]').count(),
    0,
  );
  const tool = visitorPage
    .locator('.tool-output')
    .filter({ hasText: 'echo restored' });
  assert.equal(await tool.getAttribute('open'), null);
  const group = tool.locator('xpath=..');
  assert.equal(await group.getAttribute('open'), null);
  await group.locator(':scope > summary').click();
  await tool.locator('summary').click();
  assert.notEqual(await tool.getAttribute('open'), null);
  await feature(visitorPage, /^会话记录/);
  await visitorPage
    .getByRole('button', { name: '加载更多', exact: true })
    .click();
  await wait(
    async () =>
      (await visitorPage
        .getByRole('button', { name: '加载更多', exact: true })
        .count()) === 0,
    'history pagination',
  );
  assert.equal(
    await visitorPage.getByRole('button', { name: /本地历史对话/ }).count(),
    1,
  );
  await visitorPage.getByLabel('搜索会话').fill('no matching history');
  assert.equal(
    await visitorPage.getByRole('button', { name: /本地历史对话/ }).count(),
    0,
  );
  await visitorPage.getByLabel('搜索会话').fill('');
  await visitorPage.keyboard.press('Escape');
  await visitorPage.getByRole('dialog').waitFor({ state: 'hidden' });
  await visitorPage.locator('.messages').evaluate((el) => {
    el.scrollTop = 0;
  });
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-chat-markdown.png'),
    fullPage: true,
  });
  await visitorPage
    .getByLabel('任务内容')
    .fill('continue restored conversation');
  await visitorPage.getByLabel('任务内容').press('Enter');
  await visitorPage
    .getByText('echo: continue restored conversation', { exact: true })
    .waitFor();
  await idle(visitorPage);
  await focusedChat(visitorPage);
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-chat-desktop.png'),
    fullPage: true,
  });
  await visitorPage.setViewportSize({ width: 390, height: 844 });
  await focusedChat(visitorPage);
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-chat-mobile.png'),
    fullPage: true,
  });
  assert(
    await visitorPage.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await visitorPage.setViewportSize({ width: 1280, height: 900 });
  await visitorPage.getByRole('button', { name: '功能菜单' }).click();
  await visitorPage.getByRole('button', { name: /^会话记录/ }).click();
  assert.equal(await visitorPage.locator('.conversation').count(), 1);
  assert(
    await visitorPage
      .getByRole('dialog')
      .getByRole('region', { name: '连接设置' })
      .isVisible(),
  );
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-session-connections-desktop.png'),
  });
  await visitorPage.keyboard.press('Escape');
  await focusedChat(visitorPage);
  await visitorPage.getByRole('button', { name: '功能菜单' }).click();
  await visitorPage.keyboard.press('Escape');
  assert.equal(
    await visitorPage.getByRole('navigation', { name: '功能菜单' }).count(),
    0,
  );
  await visitorPage.getByRole('button', { name: '功能菜单' }).click();
  await visitorPage.waitForTimeout(4500);
  assert.equal(
    await visitorPage.getByRole('navigation', { name: '功能菜单' }).isVisible(),
    true,
  );
  await visitorPage.getByRole('button', { name: /CW 对话 会话/ }).click();
  await visitorPage
    .getByText('echo: continue restored conversation', { exact: true })
    .waitFor();
  pass(
    'local history restore, Markdown tables/code and safe links, collapsed tools, pagination/search, keyboard submit, mobile layout and functional navigation',
  );
  await idle(visitorPage);
  await feature(visitorPage, /^会话详情/);
  await visitorPage.getByText(/已连接 · 空闲/).waitFor();
  await visitorPage.keyboard.press('Escape');
  await focusedChat(visitorPage);
  await visitorPage.getByLabel('任务内容').fill('hold focused chat');
  await visitorPage.getByRole('button', { name: '发送', exact: true }).click();
  await visitorPage
    .getByRole('button', { name: '停止本轮', exact: true })
    .click();
  await idle(visitorPage);
  await visitorPage.getByLabel('任务内容').fill('approval focused chat');
  await visitorPage.getByRole('button', { name: '发送', exact: true }).click();
  await visitorPage.getByText('等待你的确认 · 1 / 1').waitFor();
  await visitorPage.getByRole('button', { name: '拒绝', exact: true }).click();
  await visitorPage.getByText('denied', { exact: true }).waitFor();
  await idle(visitorPage);
  pass(
    'full viewport chat, menu-only metadata/history, dialog close and Escape, stop and explicit approvals remain accessible',
  );

  mkdirSync(join(dir, 'transfer-fixtures'));
  symlinkSync('/etc', join(dir, 'transfer-fixtures', 'escape'));
  const binary = Buffer.alloc(150003);
  for (let i = 0; i < binary.length; i++) binary[i] = i % 256;
  await feature(visitorPage, /^工作区文件/);
  await visitorPage
    .getByRole('button', { name: '目录 · transfer-fixtures', exact: true })
    .click();
  await visitorPage
    .getByText('当前目录没有可传输的文件。', { exact: true })
    .waitFor();
  await visitorPage.getByLabel('选择上传文件').setInputFiles({
    name: 'binary.bin',
    mimeType: 'application/octet-stream',
    buffer: binary,
  });
  await visitorPage
    .getByRole('button', { name: '上传文件', exact: true })
    .click();
  await visitorPage.getByText(/已上传 binary.bin/).waitFor();
  assert.deepEqual(
    readFileSync(join(dir, 'transfer-fixtures', 'binary.bin')),
    binary,
  );
  const downloaded = visitorPage.waitForEvent('download');
  await visitorPage
    .getByRole('button', { name: '下载 binary.bin', exact: true })
    .click();
  const download = await downloaded;
  await download.saveAs(join(dir, 'downloaded.bin'));
  assert.deepEqual(readFileSync(join(dir, 'downloaded.bin')), binary);
  await visitorPage.getByLabel('选择上传文件').setInputFiles({
    name: 'binary.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('replacement'),
  });
  await visitorPage
    .getByRole('button', { name: '上传文件', exact: true })
    .click();
  await visitorPage.getByRole('dialog').getByRole('alert').waitFor();
  assert.deepEqual(
    readFileSync(join(dir, 'transfer-fixtures', 'binary.bin')),
    binary,
  );
  await visitorPage.getByLabel('覆盖已有文件').check();
  visitorPage.once('dialog', (dialog) => void dialog.accept());
  await visitorPage
    .getByRole('button', { name: '上传文件', exact: true })
    .click();
  await visitorPage.getByText(/已上传 binary.bin/).waitFor();
  assert.equal(
    readFileSync(join(dir, 'transfer-fixtures', 'binary.bin'), 'utf8'),
    'replacement',
  );
  // Lose a response after A has durably accepted the first chunk, then close
  // and reopen the panel. Recovery must use the saved body and A's offset.
  let chunkLost = false;
  agent.interruptReplyWhen(() => {
    chunkLost = readdirSync(join(dir, 'transfer-fixtures')).some(
      (name) =>
        name.startsWith('.coc-upload-') &&
        statSync(join(dir, 'transfer-fixtures', name)).size >= 65536,
    );
    return chunkLost;
  });
  await visitorPage.getByLabel('选择上传文件').setInputFiles({
    name: 'resumed.bin',
    mimeType: 'application/octet-stream',
    buffer: binary,
  });
  visitorPage.once('dialog', (dialog) => void dialog.accept());
  await visitorPage
    .getByRole('button', { name: '上传文件', exact: true })
    .click();
  await wait(() => chunkLost, 'lost upload chunk response');
  await visitorPage
    .getByRole('button', { name: '暂停传输', exact: true })
    .click();
  await visitorPage.keyboard.press('Escape');
  await visitorPage.getByRole('dialog').waitFor({ state: 'hidden' });
  agent.releaseInterruptedReply();
  await wait(
    async () => (await request(`/hosts/${enrolled.hostId}/probe`, {})).r.ok,
    'Agent reconnect after losing the persisted upload chunk response',
    45000,
  );
  await feature(visitorPage, /^工作区文件/);
  await visitorPage.getByText(/已上传 resumed.bin/).waitFor();
  assert.deepEqual(
    readFileSync(join(dir, 'transfer-fixtures', 'resumed.bin')),
    binary,
  );
  assert(
    !readdirSync(join(dir, 'transfer-fixtures')).some((name) =>
      name.startsWith('.coc-upload-'),
    ),
  );
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-workspace-files.png'),
    fullPage: true,
  });
  await visitorPage.setViewportSize({ width: 390, height: 844 });
  assert(
    await visitorPage.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-workspace-files-mobile.png'),
    fullPage: true,
  });
  await visitorPage.keyboard.press('Escape');
  await visitorPage.getByRole('dialog').waitFor({ state: 'hidden' });
  // The upload channel can recover before the independent chat controller.
  // Await its recovery, then dismiss the expected fault-injection alert.
  await idle(visitorPage);
  const offlineAlert = visitorPage.locator('.error').filter({
    hasText: 'HOST_OFFLINE: Target offline',
  });
  if (await offlineAlert.isVisible())
    await offlineAlert
      .getByRole('button', { name: '关闭', exact: true })
      .click();
  await focusedChat(visitorPage);
  await visitorPage.setViewportSize({ width: 1280, height: 900 });
  pass(
    'workspace file menu: binary upload/download, lost chunk and panel-reopen recovery, symlink exclusion, explicit overwrite, and return to focused chat',
  );

  // Revoke the active visitor CW grant while preserving its other A cookie.
  const visitorGrant = (
    await api('/admin/devices', undefined, { admin: true })
  ).credentials.find(
    (c: any) =>
      c.role === 'web' &&
      c.name === '网页客户端' &&
      c.hostId === enrolled.hostId,
  );
  await page.getByRole('tab', { name: '已授权设备', exact: true }).click();
  const visitorGrantRow = page.locator(
    `[data-credential-id="${visitorGrant.id}"]`,
  );
  const visitorGroup = page
    .locator('details.device-group')
    .filter({ has: visitorGrantRow });
  if ((await visitorGroup.getAttribute('open')) === null)
    await visitorGroup.locator(':scope > summary').click();
  page.once('dialog', (dialog) => void dialog.accept());
  await visitorGrantRow
    .getByRole('button', { name: '撤销 网页客户端', exact: true })
    .click();
  await wait(
    async () => (await visitorPage.getByText(/登录已过期或被撤销/).count()) > 0,
    'CW revocation closes live connection',
  );
  await visitorPage.reload();
  await visitorPage.locator('.chat-workspace').waitFor();
  await feature(visitorPage, /^会话记录/);
  await visitorPage.getByLabel('主机').waitFor();
  assert.equal(
    await visitorPage.getByLabel('主机').locator('option').count(),
    2,
  );
  assert.equal(
    (await api('/admin/devices', undefined, { admin: true })).credentials.some(
      (c: any) => c.id === visitorGrant.id,
    ),
    false,
  );
  pass(
    'administrator UI revokes active CW without removing another A authorization',
  );
  await idle(otherPage);
  await otherPage.getByLabel('任务内容').fill('still authorized');
  await otherPage.getByRole('button', { name: '发送', exact: true }).click();
  await otherPage
    .getByText('echo: still authorized', { exact: true })
    .waitFor();
  assert.equal(
    await visitorPage
      .getByText('echo: still authorized', { exact: true })
      .count(),
    0,
  );
  pass(
    'two tabs independently control two A servers and retain the other authorization after revocation',
  );
  await browser.close();
  browser = undefined;
  // Detach and reconnect Agent transport, without restarting its runtimes.
  token = '';
  const reconnectSession = (
    await api('/sessions?hostId=' + enrolled.hostId)
  ).find((x: any) => x.mode === 'web' && x.state === 'ready');
  // Browser shutdown and DO close delivery are asynchronous; explicitly acquire the test controller.
  const reconnect = await web(reconnectSession.id, true);
  reconnect.ws.close();
  await wait(
    () => reconnect.ws.readyState === WebSocket.CLOSED,
    'client detach',
  );
  agent.socket!.terminate();
  await wait(
    () => agent!.socket?.readyState === WebSocket.OPEN,
    'Agent reconnect',
    45000,
  );
  await wait(
    async () =>
      (await api('/hosts')).some(
        (host: any) => host.id === enrolled.hostId && host.online,
      ),
    'Agent protocol negotiation after reconnect',
  );
  const restored = await web(reconnectSession.id, true);
  restored.send(JSON.stringify({ action: 'sync', after: 0 }));
  await wait(
    () => restored.messages.some((m) => m.type === 'sync'),
    'restored web session',
  );
  pass('Agent network reconnect preserves runtime and web history');
  const credentials = (await api('/admin/devices', undefined, { admin: true }))
    .credentials;
  const cc = credentials.find(
    (c: any) =>
      c.id ===
      createHash('sha256').update(clientCredentials.token).digest('hex'),
  );
  assert(cc, 'paired CC credential remains independent of API keys');
  // A live CW writer keeps another session in this project read-only.
  token = clientCredentials.token;
  const blockedCli = await api('/sessions', {
    hostId: enrolled.hostId,
    projectId: 'test-project',
    mode: 'cli',
  });
  const blockedAttach = await request(`/sessions/${blockedCli.id}/attach`, {});
  assert.equal(blockedAttach.r.status, 409);
  assert.equal(blockedAttach.b.error.code, 'PROJECT_READ_ONLY');
  await api(`/sessions/${blockedCli.id}/stop`, {});
  assert.equal(restored.ws.readyState, WebSocket.OPEN);
  pass('live project writer rejects another CLI writer without disrupting CW');
  // Revocation isolation needs two legitimate writers, hence distinct projects.
  const projectEndpoint = `/admin/hosts/${enrolled.hostId}/project-management`;
  const projectState = await api(projectEndpoint, undefined, { admin: true });
  await api(
    projectEndpoint,
    {
      operation: 'add',
      requestId: randomUUID(),
      revision: projectState.revision,
      id: 'revocation-project',
      name: 'Revocation project',
      path: revocationDir,
    },
    { admin: true },
  );
  const activeCli = await api('/sessions', {
    hostId: enrolled.hostId,
    projectId: 'revocation-project',
    mode: 'cli',
  });
  const activeTicket = await api(`/sessions/${activeCli.id}/attach`, {});
  const activePeer = peer('/ws/v1/cli/' + activeCli.id, activeTicket.ticket);
  await new Promise<void>((resolve, reject) => {
    activePeer.ws.once('open', resolve);
    activePeer.ws.once('error', reject);
  });
  await api('/admin/revoke', { id: cc.id }, { admin: true });
  await wait(
    () => activePeer.ws.readyState === WebSocket.CLOSED,
    'CC revocation closes live connection',
  );
  assert.equal(activePeer.closeCode, 4001);
  assert.equal(restored.ws.readyState, WebSocket.OPEN);

  token = clientCredentials.token;
  assert.equal((await request('/hosts')).r.status, 401);
  token = '';
  const a = credentials.find(
    (c: any) => c.role === 'agent' && c.hostId === enrolled.hostId,
  );
  await api('/admin/revoke', { id: a.id }, { admin: true });
  await wait(
    () => restored.ws.readyState === WebSocket.CLOSED,
    'revoked client closes',
  );
  assert.equal((await request('/hosts')).r.status, 401);
  pass(
    'R revocation rejects CC credentials and A revocation closes active connections',
  );
  await cliCommand(['logout']);
  console.log(
    'All local end-to-end checks passed (deterministic Codex peer + real Wrangler + Chromium).',
  );
} catch (e) {
  if (browser) {
    mkdirSync(artifacts, { recursive: true });
    let index = 0;
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        const name = `e2e-failure-${index++}`;
        await page
          .screenshot({
            path: join(artifacts, name + '.png'),
            fullPage: true,
            timeout: 5000,
          })
          .catch(() => {});
        console.error(
          name,
          await page
            .locator('.composer, .error, .conversation .status, .chat-welcome')
            .allTextContents()
            .catch(() => []),
        );
      }
    }
  }
  console.error(logs.replaceAll(secret, '[test-secret]'));
  throw e;
} finally {
  for (const s of sockets) s.terminate();
  if (browser) await browser.close();
  if (agent && !agent.stopped) await agent.close();
  if (otherAgent && !otherAgent.stopped) await otherAgent.close();
  await sharedApprovals.close();
  if (wakeService)
    await new Promise<void>((done) => wakeService!.close(() => done()));
  try {
    process.kill(-worker.pid!, 'SIGTERM');
  } catch {
    /* Process already exited. */
  }
  await new Promise((r) => setTimeout(r, 400));
  rmSync(dir, { recursive: true, force: true });
  rmSync(revocationDir, { recursive: true, force: true });
}

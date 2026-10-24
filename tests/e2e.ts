import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  statSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { chromium } from '@playwright/test';
import { Agent } from './support/native-agent.ts';

const dir = mkdtempSync(join(tmpdir(), 'coc-e2e-'));
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
let token = '',
  cookie = '',
  agent: Agent | undefined,
  browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const sockets: WebSocket[] = [];
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
  options: { anonymous?: boolean; key?: string; origin?: string } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: options.origin || origin,
  };
  if (!options.anonymous) headers.Authorization = 'Bearer ' + token;
  if (data !== undefined)
    headers['Idempotency-Key'] = options.key || randomUUID();
  const r = await fetch(origin + '/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const b: any = await r.json();
  return { r, b };
}
async function api(path: string, data?: unknown, opts: any = {}) {
  const { r, b } = await request(path, data, opts);
  assert.equal(r.status, 200, JSON.stringify(b));
  return b;
}
function peer(path: string, auth?: string) {
  const ws = new WebSocket(origin.replace('http', 'ws') + path, {
    headers: {
      Origin: origin,
      ...(auth ? { Authorization: 'Bearer ' + auth } : { Cookie: cookie }),
    },
  });
  const messages: any[] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  ws.on('error', () => {});
  sockets.push(ws);
  return { ws, messages };
}
async function web(id: string) {
  const t = await api(`/sessions/${id}/attach`, {});
  const p = peer('/ws/v1/web/' + id);
  await new Promise<void>((r, j) => {
    p.ws.once('open', r);
    p.ws.once('error', j);
  });
  p.ws.send(JSON.stringify({ type: 'auth', ticket: t.ticket }));
  await wait(() => p.messages.some((m) => m.type === 'attached'), 'web attach');
  return p;
}
const pass = (message: string) => console.log('PASS: ' + message);
async function cliCommand(
  args: string[],
  input = '',
  env: NodeJS.ProcessEnv = {},
) {
  const child = spawn(
    resolve(process.env.COC_CLI_BINARY || 'build/coc'),
    args,
    {
      env: {
        ...process.env,
        COC_CREDENTIALS: join(dir, 'credentials.json'),
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
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
  token = login.b.token;
  cookie = login.r.headers.get('set-cookie')!.split(';')[0];
  assert.equal(
    (
      await request(
        '/hosts/enrollments',
        { name: 'bad' },
        { origin: 'https://evil.example' },
      )
    ).r.status,
    403,
  );
  pass('login, unauthorized access and cross-origin rejection');
  assert.equal(
    (await request('/auth/codes', {}, { anonymous: true })).r.status,
    401,
  );
  const cliGrant = await api('/auth/codes', {});
  assert.ok(
    cliGrant.expires > Date.now() && cliGrant.expires <= Date.now() + 300000,
  );
  assert.equal(cliGrant.url, '/#login=' + cliGrant.code);
  await cliCommand(['login', '--relay', origin], cliGrant.code + '\n');
  assert.equal(
    (
      await request(
        '/auth/redeem',
        { code: cliGrant.code, kind: 'cli' },
        { anonymous: true },
      )
    ).r.status,
    401,
  );
  const clientCredentials = JSON.parse(
    readFileSync(join(dir, 'credentials.json'), 'utf8'),
  );
  const forbidden = await fetch(origin + '/api/v1/auth/codes', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + clientCredentials.token,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  assert.equal(forbidden.status, 403);
  const raceGrant = await api('/auth/codes', {});
  const race = await Promise.all(
    ['cli', 'web'].map((kind) =>
      request(
        '/auth/redeem',
        { code: raceGrant.code, kind },
        { anonymous: true },
      ),
    ),
  );
  assert.deepEqual(race.map(({ r }) => r.status).sort(), [200, 401]);
  pass(
    'one-time login, atomic CLI/browser redemption and administrator-only generation',
  );
  assert.equal(statSync(join(dir, 'credentials.json')).mode & 0o777, 0o600);
  const e = JSON.parse(await cliCommand(['enroll', 'local-test']));
  const configFile = join(dir, 'enrolled.json');
  await cliCommand(
    [
      'agent-enroll',
      '--relay',
      origin,
      '--config',
      configFile,
      '--project',
      dir,
      '--project-id',
      'test-project',
    ],
    e.code + '\n',
  );
  const config = JSON.parse(readFileSync(configFile, 'utf8'));
  const enrolled = { hostId: config.hostId, token: config.token };
  assert.equal(statSync(configFile).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await cliCommand(['hosts']))[0].id, enrolled.hostId);
  pass('C++ CLI login, enrollment, private configuration and host query');
  assert.equal(
    (await request('/agent/enroll', { code: e.code }, { anonymous: true })).r
      .status,
    401,
  );
  pass('one-use device enrollment');
  agent = new Agent({
    relayUrl: origin,
    hostId: enrolled.hostId,
    token: enrolled.token,
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    sandbox: 'workspace-write',
    dataDir: join(dir, 'agent'),
    projects: [{ id: 'test-project', name: 'Test project', path: dir }],
  });
  agent.start();
  await wait(async () => (await api('/hosts'))[0].online, 'Agent online');
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
    409,
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
  assert.equal(
    JSON.parse(await cliCommand(['sessions', '--host', 'local-test']))[0].id,
    s.id,
  );
  pass('Agent online, project allowlist and idempotent session creation');
  const p = await web(s.id);
  const prompt = { action: 'prompt', requestId: randomUUID(), text: 'hello' };
  p.ws.send(JSON.stringify(prompt));
  await wait(
    () => p.messages.some((m) => m.event?.type === 'turn/completed'),
    'streamed turn',
  );
  const liveEvents = p.messages
    .filter((m) => m.type === 'event')
    .map((m) => m.event);
  assert.deepEqual(
    liveEvents.map((e) => e.seq),
    liveEvents.map((e) => e.seq).sort((a, b) => a - b),
  );
  assert.equal(
    liveEvents
      .filter((e) => e.type === 'item/agentMessage/delta')
      .map((e) => e.data.delta)
      .join(''),
    'echo: hello',
  );
  p.ws.send(JSON.stringify(prompt));
  await wait(
    () =>
      p.messages.filter(
        (m) => m.type === 'ack' && m.requestId === prompt.requestId,
      ).length === 2,
    'duplicate ack',
  );
  assert.equal(p.messages.filter((m) => m.event?.type === 'user').length, 1);
  pass('streaming and duplicate prompt suppression');
  p.ws.send(
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
  p.ws.send(
    JSON.stringify({
      action: 'approval',
      requestId: randomUUID(),
      approvalId: approval.approvalId,
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
  q.ws.send(JSON.stringify({ type: 'auth', ticket: takeover.ticket }));
  await wait(() => q.messages.some((m) => m.type === 'attached'), 'takeover');
  await wait(
    () => p.ws.readyState === WebSocket.CLOSED,
    'old controller closed',
  );
  q.ws.send(JSON.stringify({ action: 'sync', after: 0 }));
  await wait(() => q.messages.some((m) => m.type === 'sync'), 'history replay');
  assert(
    q.messages
      .find((m) => m.type === 'sync')
      .events.some((e: any) => e.type === 'user'),
  );
  pass('exclusive control, explicit takeover and persistent replay');
  const reused = peer('/ws/v1/web/' + s.id);
  await new Promise<void>((r) => reused.ws.once('open', r));
  reused.ws.send(JSON.stringify({ type: 'auth', ticket: takeover.ticket }));
  await wait(
    () => reused.ws.readyState === WebSocket.CLOSED,
    'ticket replay rejected',
  );
  pass('connection ticket cannot be reused');
  await api(`/sessions/${s.id}/stop`, {});
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
  cp.ws.send(
    JSON.stringify({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'test', version: '1' } },
    }),
  );
  await wait(() => cp.messages.some((m) => m.id === 1 && m.result), 'CLI init');
  cp.ws.send(JSON.stringify({ id: 2, method: 'thread/start', params: {} }));
  await wait(
    () => cp.messages.some((m) => m.id === 2 && m.result),
    'CLI thread',
  );
  cp.ws.send(
    JSON.stringify({ id: 3, method: 'config/value/write', params: {} }),
  );
  await wait(
    () => cp.messages.some((m) => m.id === 3 && m.error),
    'CLI prohibited method',
  );
  assert(!cp.messages.some((m) => m.id === 3 && m.result));
  pass('CLI raw protocol routing and unsafe RPC rejection');
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
    launched.args[1].startsWith(origin.replace('http', 'ws') + '/ws/v1/cli/'),
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
  // Real browser uses the same cookie/Origin path as users; no bearer bypass.
  browser = await chromium.launch({
    headless: true,
    ...(process.env.COC_BROWSER_PATH
      ? { executablePath: process.env.COC_BROWSER_PATH }
      : {}),
  });
  const page = await browser.newPage();
  await page.goto(origin);
  await page.getByRole('button', { name: '管理员登录', exact: true }).click();
  await page.getByLabel('所有者密钥').fill(secret);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page
    .getByRole('button', { name: '生成一次性登录授权', exact: true })
    .click();
  await wait(
    async () => !!(await page.getByLabel('浏览器登录链接').inputValue()),
    'browser login link',
  );
  const loginLink = await page.getByLabel('浏览器登录链接').inputValue();
  const webGrantCode = await page.getByLabel('coc 一次性验证码').inputValue();
  const visitor = await browser.newContext();
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(loginLink);
  await visitorPage.getByLabel('一次性验证码').waitFor();
  assert.equal(
    await visitorPage.getByLabel('一次性验证码').inputValue(),
    webGrantCode,
  );
  assert.equal(visitorPage.url(), origin + '/');
  await visitorPage.getByRole('button', { name: '登录', exact: true }).click();
  await visitorPage.getByLabel('主机').waitFor();
  assert.equal(
    await visitorPage.getByRole('heading', { name: '客户端登录授权' }).count(),
    0,
  );
  assert.equal(
    (
      await request(
        '/auth/redeem',
        { code: webGrantCode, kind: 'cli' },
        { anonymous: true },
      )
    ).r.status,
    401,
  );
  await visitorPage.screenshot({
    path: process.env.COC_LOGIN_SCREENSHOT_PATH || join(dir, 'login-link.png'),
    fullPage: true,
  });
  await visitor.close();
  pass(
    'administrator generates link, browser confirms login, fragment removed and code cannot be reused',
  );
  await page.getByLabel('主机').selectOption(enrolled.hostId);
  await page.getByRole('button', { name: '创建网页会话' }).click();
  await page.getByText(/已连接 · 空闲/).waitFor();
  await page.getByLabel('任务内容').fill('browser hello');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('echo: browser hello', { exact: true }).waitFor();
  await page.getByText(/已连接 · 空闲/).waitFor();
  await page.getByLabel('任务内容').fill('hello 你好，世界！');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('echo: hello 你好，世界！', { exact: true }).waitFor();
  await page.getByText(/已连接 · 空闲/).waitFor();
  const browserSession = await page.locator('.conversation .id').innerText();
  await page.reload();
  await page.getByLabel('主机').selectOption(enrolled.hostId);
  await page
    .getByRole('button', {
      name: browserSession.split('~')[1].slice(0, 8) + ' · web · ready',
      exact: true,
    })
    .click();
  await page.getByText('echo: browser hello', { exact: true }).waitFor();
  await page.getByText('echo: hello 你好，世界！', { exact: true }).waitFor();
  await page.getByText(/已连接 · 空闲/).waitFor();
  pass(
    'character-by-character English/Chinese streaming and ordered history after browser reload',
  );
  await page.screenshot({
    path: process.env.COC_SCREENSHOT_PATH || join(dir, 'browser.png'),
    fullPage: true,
  });
  pass(
    'browser cookie login, project selection, task submission and streaming',
  );
  await browser.close();
  browser = undefined;
  // Detach and reconnect Agent transport, without restarting its runtimes.
  const reconnectSession = (
    await api('/sessions?hostId=' + enrolled.hostId)
  ).find((x: any) => x.mode === 'web' && x.state === 'ready');
  const reconnect = await web(reconnectSession.id);
  reconnect.ws.close();
  await wait(
    () => reconnect.ws.readyState === WebSocket.CLOSED,
    'client detach',
  );
  agent.socket!.terminate();
  await wait(
    () => agent!.socket?.readyState === WebSocket.OPEN,
    'Agent reconnect',
    15000,
  );
  const restored = await web(reconnectSession.id);
  restored.ws.send(JSON.stringify({ action: 'sync', after: 0 }));
  await wait(
    () => restored.messages.some((m) => m.type === 'sync'),
    'restored web session',
  );
  pass('Agent network reconnect preserves runtime and web history');
  await cliCommand(['revoke', '--host', 'local-test']);
  await wait(
    () => restored.ws.readyState === WebSocket.CLOSED,
    'revoked client closes',
  );
  assert.equal((await api('/hosts'))[0].online, false);
  pass('C++ CLI revocation closes active connections');
  await cliCommand(['logout']);
  console.log(
    'All local end-to-end checks passed (deterministic Codex peer + real Wrangler + Chromium).',
  );
} catch (e) {
  console.error(logs.replaceAll(secret, '[test-secret]'));
  throw e;
} finally {
  for (const s of sockets) s.terminate();
  if (browser) await browser.close();
  if (agent && !agent.stopped) await agent.close();
  try {
    process.kill(-worker.pid!, 'SIGTERM');
  } catch {
    /* Process already exited. */
  }
  await new Promise((r) => setTimeout(r, 400));
  rmSync(dir, { recursive: true, force: true });
}

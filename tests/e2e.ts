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
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { chromium, type Page } from '@playwright/test';
import { Agent } from './support/native-agent.ts';

const dir = mkdtempSync(join(tmpdir(), 'coc-e2e-'));
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
  options: {
    anonymous?: boolean;
    key?: string;
    origin?: string;
    admin?: boolean;
    cookie?: string;
  } = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Origin: options.origin || origin,
  };
  if (options.admin) headers.Authorization = 'Bearer ' + adminToken;
  else if (!options.anonymous) {
    if (token) headers.Authorization = 'Bearer ' + token;
    else if (cookie) headers.Cookie = cookie;
  }
  if (options.cookie) headers.Cookie = options.cookie;
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
  // Local workerd may leave TCP half-closed after a valid close frame.
  const options = {
    closeTimeout: 1000,
    headers: {
      Origin: origin,
      ...(auth ? { Authorization: 'Bearer ' + auth } : { Cookie: cookie }),
    },
  };
  const ws = new WebSocket(origin.replace('http', 'ws') + path, options);
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
    get closeCode() {
      return closeCode;
    },
  };
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
async function feature(page: Page, name: RegExp) {
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
      messageHeight: messages.height,
      composerBottom: composer.bottom,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
    };
  });
  assert(geometry.chatHeight > geometry.height * 0.85);
  assert.equal(await page.locator('.workspace-context').isVisible(), true);
  assert(geometry.messageHeight > geometry.height * 0.65);
  assert(geometry.composerBottom <= geometry.height);
  assert(geometry.scrollWidth <= geometry.width);
  assert(geometry.scrollHeight <= geometry.height);
}

async function cliCommand(
  args: string[],
  input = '',
  env: NodeJS.ProcessEnv = {},
  binary = process.env.COC_CLI_BINARY || 'build/coc-client',
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
      void api('/admin/approve', { id }, { admin: true }).catch((e) => {
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
  await cliCommand(['login', '--relay', origin, '--host', enrolled.hostId]);
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
  await cliCommand(['login', '--relay', origin, '--host', other.hostId]);
  assert.equal(
    JSON.parse(readFileSync(join(dir, 'credentials.json'), 'utf8')).entries
      .length,
    2,
  );
  await cliCommand(['use', '--host', enrolled.hostId]);
  const webStart = await request(
    '/auth/device/start',
    { role: 'web', name: 'API web', hostId: enrolled.hostId },
    { anonymous: true },
  );
  assert.equal(webStart.b.pollSecret, undefined);
  const pendingCookie = webStart.r.headers.get('set-cookie')!.split(';')[0];
  await api('/admin/approve', { id: webStart.b.id }, { admin: true });
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
  otherAgent = new Agent({
    relayUrl: origin,
    hostId: other.hostId,
    token: other.token,
    codexPath: process.execPath,
    codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
    sandbox: 'workspace-write',
    dataDir: join(dir, 'other-agent'),
    projects: [{ id: 'other-project', name: 'Other project', path: dir }],
  });
  otherAgent.start();
  await wait(
    async () =>
      JSON.parse(await cliCommand(['status', '--host', other.hostId]))[0]
        .online,
    'other Agent online',
  );
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
    ['local-history'],
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
    hp.ws.send(JSON.stringify({ ...data, requestId }));
    await wait(
      () => hp.messages.some((m) => m.requestId === requestId),
      'history response',
    );
    return hp.messages.find((m) => m.requestId === requestId);
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
  assert.equal(
    (await api(`/hosts/${enrolled.hostId}/requests/${key}`)).result.id,
    s.id,
  );
  const tickets = await Promise.all([
    api(`/sessions/${s.id}/attach`, {}),
    api(`/sessions/${s.id}/attach`, {}),
  ]);
  const competitors = tickets.map(() => peer('/ws/v1/web/' + s.id));
  await Promise.all(
    competitors.map(
      (p) => new Promise<void>((resolve) => p.ws.once('open', resolve)),
    ),
  );
  competitors.forEach((p, i) =>
    p.ws.send(JSON.stringify({ type: 'auth', ticket: tickets[i].ticket })),
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
  const p = competitors.find((p) =>
    p.messages.some((m) => m.type === 'attached'),
  )!;
  pass('real DO concurrent attach permits exactly one controller');
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
  agent.loseNextAttachReply();
  const lostTicket = await api(`/sessions/${s.id}/takeover`, {});
  const lostController = peer('/ws/v1/web/' + s.id);
  await new Promise<void>((done) => lostController.ws.once('open', done));
  lostController.ws.send(
    JSON.stringify({ type: 'auth', ticket: lostTicket.ticket }),
  );
  await wait(
    () =>
      lostController.messages.some((m) => m.error?.code === 'RESULT_UNKNOWN'),
    'lost attach confirmation',
    16000,
  );
  assert.equal(p.ws.readyState, WebSocket.OPEN);
  p.ws.send(JSON.stringify(prompt));
  await wait(
    () =>
      p.messages.filter(
        (m) => m.type === 'ack' && m.requestId === prompt.requestId,
      ).length === 3,
    'old controller survives lost takeover acknowledgement',
  );
  pass(
    'lost Agent attach acknowledgement preserves existing native controller',
  );
  await new Promise((done) => setTimeout(done, 3200));
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
  const cliThread = cp.messages.find((m) => m.id === 2).result.thread.id;
  cp.ws.send(
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
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /连接设置 主机/ }).click();
  await page.getByRole('button', { name: '管理员登录', exact: true }).click();
  await page.getByLabel('所有者密钥').fill(secret);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '设备授权管理' }).waitFor();
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
  const visitor = await browser.newContext();
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(origin);
  await visitorPage.getByLabel('服务器标识').fill(enrolled.hostId);
  await visitorPage
    .getByRole('button', { name: '申请登录', exact: true })
    .click();
  const pending = await visitorPage.locator('strong').innerText();
  await page
    .getByRole('button', { name: '批准 ' + pending, exact: true })
    .click();
  await visitorPage.locator('.chat-workspace').waitFor();
  await feature(visitorPage, /连接设置 主机/);
  await visitorPage.getByLabel('主机').waitFor();
  assert.equal(
    await visitorPage.getByRole('heading', { name: '设备授权管理' }).count(),
    0,
  );
  const browserCookies = await visitor.cookies();
  const webCookie = browserCookies.find(
    (c) => c.name === 'coc_web_' + enrolled.hostId,
  )!;
  assert(webCookie.httpOnly);
  assert(webCookie.expires * 1000 > Date.now() + 300 * 86400000);
  // Save another A credential in the same browser, then switch back to the online A.
  await visitorPage.getByRole('button', { name: '功能菜单' }).click();
  await visitorPage.getByRole('button', { name: /连接设置 主机/ }).click();
  await visitorPage.getByRole('button', { name: '添加 A 授权' }).click();
  await visitorPage.getByLabel('服务器标识').fill(other.hostId);
  await visitorPage
    .getByRole('button', { name: '申请登录', exact: true })
    .click();
  const secondCode = await visitorPage.locator('strong').innerText();
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
  await feature(visitorPage, /连接设置 主机/);
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
  // Different tabs select their own host cookie; the selected identity is not global.
  const otherPage = await visitor.newPage();
  await otherPage.goto(origin);
  await feature(otherPage, /连接设置 主机/);
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
  await feature(visitorPage, /连接设置 主机/);
  await visitorPage.getByLabel('主机').selectOption(enrolled.hostId);
  await visitorPage.getByRole('button', { name: '创建网页会话' }).click();
  await idle(visitorPage);
  await visitorPage.getByLabel('任务内容').fill('browser hello');
  await visitorPage.getByRole('button', { name: '发送', exact: true }).click();
  await visitorPage.getByText('echo: browser hello', { exact: true }).waitFor();
  await idle(visitorPage);
  await visitorPage.getByLabel('任务内容').fill('hello 你好，世界！');
  await visitorPage.getByRole('button', { name: '发送', exact: true }).click();
  await visitorPage
    .getByText('echo: hello 你好，世界！', { exact: true })
    .waitFor();
  await idle(visitorPage);
  const browserSession = await sessionId(visitorPage);
  await visitorPage.reload();
  await feature(visitorPage, /连接设置 主机/);
  await visitorPage.getByLabel('主机').selectOption(enrolled.hostId);
  await feature(visitorPage, /^会话记录/);
  await visitorPage
    .getByRole('button', { name: /browser hello/ })
    .first()
    .click();
  assert.equal(await sessionId(visitorPage), browserSession);
  await visitorPage.getByText('echo: browser hello', { exact: true }).waitFor();
  await visitorPage
    .getByText('echo: hello 你好，世界！', { exact: true })
    .waitFor();
  await idle(visitorPage);
  pass(
    'character-by-character English/Chinese streaming and ordered history after browser reload',
  );
  const cacheSize = await visitorPage.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('coc-history');
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
  await visitorPage.routeWebSocket('**/ws/v1/history/**', (route) => {
    if (historyOffline)
      route.close({ code: 1013, reason: 'Test history offline' });
    else route.connectToServer();
  });
  await visitorPage.route('**/api/v1/hosts/*/projects', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'HOST_OFFLINE', message: 'Test Agent offline' },
      }),
    }),
  );
  await visitorPage.reload();
  await feature(visitorPage, /连接设置 主机/);
  await visitorPage.getByLabel('主机').selectOption(enrolled.hostId);
  await feature(visitorPage, /^会话记录/);
  await visitorPage
    .getByRole('button', { name: /browser hello/ })
    .first()
    .click();
  await visitorPage.getByText('echo: browser hello', { exact: true }).waitFor();
  await visitorPage.screenshot({
    path: join(artifacts, 'cw-history-cache.png'),
    fullPage: true,
  });
  historyOffline = false;
  await visitorPage.unroute('**/api/v1/hosts/*/projects');
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
  await visitorPage.getByRole('button', { name: /本地历史对话/ }).click();
  await visitorPage.getByRole('dialog').waitFor({ state: 'hidden' });
  await visitorPage.getByRole('heading', { name: 'Restored reply' }).waitFor();
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
  await visitorPage.getByRole('button', { name: /连接设置 主机/ }).click();
  assert.equal(await visitorPage.locator('.conversation').count(), 0);
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
  await focusedChat(visitorPage);
  await visitorPage.setViewportSize({ width: 1280, height: 900 });
  pass(
    'workspace file menu: multi-chunk binary upload/download, symlink exclusion, explicit overwrite, and return to focused chat',
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
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .locator(`[data-credential-id="${visitorGrant.id}"]`)
    .getByRole('button', { name: '撤销 网页客户端', exact: true })
    .click();
  await wait(
    async () => (await visitorPage.getByText(/登录已过期或被撤销/).count()) > 0,
    'CW revocation closes live connection',
  );
  await visitorPage.reload();
  await visitorPage.locator('.chat-workspace').waitFor();
  await feature(visitorPage, /连接设置 主机/);
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
  const credentials = (await api('/admin/devices', undefined, { admin: true }))
    .credentials;
  const cc = credentials.find(
    (c: any) =>
      c.id ===
      createHash('sha256').update(clientCredentials.token).digest('hex'),
  );
  assert(cc, 'paired CC credential remains independent of API keys');
  token = clientCredentials.token;
  const activeCli = await api('/sessions', {
    hostId: enrolled.hostId,
    projectId: 'test-project',
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
  console.error(logs.replaceAll(secret, '[test-secret]'));
  throw e;
} finally {
  for (const s of sockets) s.terminate();
  if (browser) await browser.close();
  if (agent && !agent.stopped) await agent.close();
  if (otherAgent && !otherAgent.stopped) await otherAgent.close();
  try {
    process.kill(-worker.pid!, 'SIGTERM');
  } catch {
    /* Process already exited. */
  }
  await new Promise((r) => setTimeout(r, 400));
  rmSync(dir, { recursive: true, force: true });
}

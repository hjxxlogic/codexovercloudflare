// Real Worker, native Agent/CC and Chromium. Temporary state; no model or production calls.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
const root = mkdtempSync(join(tmpdir(), 'coc-projects-e2e-'));
const artifacts = process.env.COC_ARTIFACT_DIR || '.local/project-evidence';
mkdirSync(artifacts, { recursive: true });
const secret = randomBytes(32).toString('hex');
const socket = createServer();
await new Promise<void>((r) => socket.listen(0, '127.0.0.1', r));
const port = (socket.address() as any).port;
await new Promise<void>((r) => socket.close(() => r()));
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
    join(root, 'worker'),
    '--var',
    'OWNER_SECRET:' + secret,
    '--var',
    'ACCESS_ENABLED:false',
  ],
  {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      WRANGLER_SEND_METRICS: 'false',
      XDG_CONFIG_HOME: join(root, 'xdg'),
    },
  },
);
let logs = '',
  owner = '';
worker.stdout.on('data', (d) => (logs += d));
worker.stderr.on('data', (d) => (logs += d));
let agent: ChildProcess | undefined, client: ChildProcess | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
async function wait(
  fn: () => Promise<boolean> | boolean,
  label: string,
  timeout = 30000,
) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Timeout: ' + label);
}
async function api(path: string, data?: unknown) {
  const headers = {
    'Content-Type': 'application/json',
    'X-CoC-Async': '1',
    Origin: origin,
    Authorization: 'Bearer ' + owner,
  };
  const res = await fetch(origin + '/api/v1' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers,
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  let result: any = await res.json();
  assert(res.ok, JSON.stringify(result));
  if (res.status === 202) {
    const receipt = `/api/v1/admin/hosts/${result.hostId}/operations/${result.operationId}`;
    await wait(async () => {
      const response = await fetch(origin + receipt, { headers });
      assert(response.ok, await response.clone().text());
      result = await response.json();
      return result.state === 'completed';
    }, 'project receipt');
    assert(!result.error, JSON.stringify(result.error));
    await fetch(origin + receipt, { method: 'POST', headers, body: '{}' });
    result = result.result;
  }
  return result;
}
try {
  await wait(
    async () => {
      try {
        return (await fetch(origin + '/api/v1/healthz')).ok;
      } catch {
        return false;
      }
    },
    'Worker startup',
    60000,
  );
  owner = (await api('/auth/login', { secret, kind: 'cli' })).token;
  const key = await api('/admin/api-keys', {
    role: 'agent',
    name: 'Multi-project test',
  });
  const grant = await api('/auth/api-key', {
    role: 'agent',
    apiKey: key.apiKey,
    name: 'Multi-project test',
  });
  const host = grant.hostId;
  const file = join(root, 'agent.json');
  writeFileSync(
    file,
    JSON.stringify({
      relayUrl: origin,
      hostId: host,
      token: key.apiKey,
      projects: [],
      dataDir: join(root, 'state'),
      autoUpdate: false,
      codexPath: process.execPath,
      codexArgs: [resolve('tests/fixtures/fake-codex.mjs')],
      sandbox: 'workspace-write',
    }),
    { mode: 0o600 },
  );
  agent = spawn(
    resolve(process.env.COC_AGENT_BINARY || 'build/coc-agent'),
    ['run', '--config', file],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let agentLog = '';
  agent.stdout!.on('data', (d) => (agentLog += d));
  agent.stderr!.on('data', (d) => (agentLog += d));
  await wait(() => agentLog.includes('Agent connected'), 'Agent connects');
  const configurationEndpoint = `/admin/hosts/${host}/configuration`;
  await wait(
    async () =>
      (await api(configurationEndpoint)).targets.some(
        (target: any) => target.id === 'agent',
      ),
    'Agent configuration capability',
  );
  const originalConfiguration = await api(configurationEndpoint, {
    target: 'agent',
    command: { action: 'read' },
  });
  const nextConfiguration = {
    ...JSON.parse(originalConfiguration.text),
    codexUseProxy: true,
  };
  const replacementCommand = {
    action: 'replace',
    requestId: randomUUID(),
    revision: originalConfiguration.revision,
    text: JSON.stringify(nextConfiguration, null, 2) + '\n',
  };
  const replacement = await api(configurationEndpoint, {
    target: 'agent',
    command: replacementCommand,
  });
  assert.equal(replacement.state, 'replaced');
  assert.equal(readFileSync(file, 'utf8'), replacementCommand.text);
  assert.equal(
    readFileSync(file + '.remote.previous', 'utf8'),
    originalConfiguration.text,
  );
  assert.deepEqual(
    await api(configurationEndpoint, {
      target: 'agent',
      command: replacementCommand,
    }),
    replacement,
  );
  const restartCommand = {
    action: 'restart',
    requestId: randomUUID(),
    revision: replacement.revision,
    allowActive: false,
  };
  assert.equal(
    (
      await api(configurationEndpoint, {
        target: 'agent',
        command: restartCommand,
      })
    ).state,
    'restart-requested',
  );
  await wait(
    () => agentLog.split('Agent connected').length === 3,
    'Real Worker management restart reconnects',
  );
  await wait(
    async () =>
      (await api(configurationEndpoint)).targets.some(
        (target: any) => target.id === 'agent',
      ),
    'Restarted Agent management capability',
  );
  assert.equal(
    (
      await api(configurationEndpoint, {
        target: 'agent',
        command: restartCommand,
      })
    ).state,
    'restart-requested',
  );
  await new Promise((done) => setTimeout(done, 2200));
  assert.equal(
    agentLog.split('Agent connected').length,
    3,
    'Real Worker retry cannot trigger a second restart',
  );
  const endpoint = `/admin/hosts/${host}/project-management`;
  const empty = await api(endpoint);
  assert.equal(empty.projects.length, 0);
  assert.equal(empty.canManage, true);
  browser = await chromium.launch({
    headless: true,
    ...(process.env.COC_BROWSER_PATH
      ? { executablePath: process.env.COC_BROWSER_PATH }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(origin);
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await page.getByLabel('所有者密钥').fill(secret);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('tab', { name: '项目管理', exact: true }).click();
  await page.getByLabel('Agent 管理员邮箱').fill('manager@example.com');
  await page
    .getByRole('button', { name: '保存管理员邮箱', exact: true })
    .click();
  await expect(
    page.getByText('管理员邮箱已保存', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '项目管理 · Multi-project test', exact: true })
    .click();
  await expect(page.getByText('尚未登记项目', { exact: true })).toBeVisible();
  const projectPath = join(root, 'work', 'first');
  await page.getByLabel('远程目录绝对路径').fill(projectPath);
  await page.getByLabel('项目显示名', { exact: true }).fill('First project');
  await page.getByLabel('目录不存在时创建').check();
  await page.getByRole('button', { name: '添加项目', exact: true }).click();
  await expect(page.locator('.project-management strong')).toHaveText(
    'First project',
  );
  assert(existsSync(projectPath));
  await page.getByLabel('远程目录绝对路径').fill(join(root, 'work'));
  await page.getByRole('button', { name: '浏览目录', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'first', exact: true }),
  ).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept('Renamed project'));
  await page.getByRole('button', { name: '改名', exact: true }).click();
  await expect(page.locator('.project-management strong')).toHaveText(
    'Renamed project',
  );
  await page.screenshot({
    path: join(artifacts, 'projects-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'Mobile layout must not overflow',
  );
  await page.screenshot({
    path: join(artifacts, 'projects-mobile.png'),
    fullPage: true,
  });
  const clientFile = join(root, 'client.json');
  client = spawn(
    resolve(process.env.COC_CLI_BINARY || 'build/coc-client'),
    [
      'login',
      '--manager',
      '--host',
      host,
      '--relay',
      origin,
      '--config',
      clientFile,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let clientLog = '';
  client.stdout!.on('data', (d) => (clientLog += d));
  client.stderr!.on('data', (d) => (clientLog += d));
  await wait(
    () =>
      /#manager=([\w-]+)/.test(clientLog) &&
      /Pairing code: ([\w-]+)/.test(clientLog),
    'CC manager request',
  );
  const id = clientLog.match(/#manager=([\w-]+)/)![1],
    code = clientLog.match(/Pairing code: ([\w-]+)/)![1];
  // Fragment navigation must work after the previous registry refresh has settled.
  await page.waitForLoadState('networkidle');
  await page.evaluate((requestId) => {
    location.hash = 'manager=' + requestId;
  }, id);
  await expect(
    page.getByRole('heading', { name: 'CC 管理身份配对', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '读取管理配对请求', exact: true })
    .click();
  await page.getByLabel('终端配对码').fill(code);
  await page.getByRole('button', { name: '确认管理身份', exact: true }).click();
  await expect(
    page.getByText('管理身份配对已处理', { exact: true }),
  ).toBeVisible();
  await wait(
    () => client!.exitCode !== null,
    'CC management login finishes',
    20000,
  );
  assert.equal(client.exitCode, 0, clientLog);
  const cli = spawn(
    resolve(process.env.COC_CLI_BINARY || 'build/coc-client'),
    [
      'project',
      'add',
      join(root, 'work', 'second'),
      '--mkdir',
      '--name',
      'CC project',
      '--host',
      host,
      '--config',
      clientFile,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let cliOutput = '';
  cli.stdout.on('data', (d) => (cliOutput += d));
  cli.stderr.on('data', (d) => (clientLog += d));
  await wait(() => cli.exitCode !== null, 'CC project add');
  assert.equal(cli.exitCode, 0, clientLog);
  assert.equal(JSON.parse(cliOutput).projects.length, 2);
  const list = await api(endpoint);
  await api(endpoint, {
    operation: 'remove',
    id: list.projects[0].id,
    revision: list.revision,
    requestId: randomUUID(),
  });
  assert(existsSync(projectPath), 'Project unregister preserves files');
  assert.equal((await api(endpoint)).projects.length, 1);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: real Worker configuration read/replace/restart and deduplication + native Agent/CC + Chromium project CRUD, administrator binding, manager pairing, responsive UI',
  );
} catch (e) {
  writeFileSync(join(artifacts, 'worker.log'), logs);
  writeFileSync(
    join(artifacts, 'projects-failure.txt'),
    e instanceof Error ? e.stack || e.message : String(e),
  );
  await browser
    ?.contexts()[0]
    ?.pages()[0]
    ?.screenshot({
      path: join(artifacts, 'projects-failure.png'),
      fullPage: true,
    })
    .catch(() => {});
  throw e;
} finally {
  await browser?.close();
  for (const child of [client, agent])
    if (child && child.exitCode === null) {
      const close = new Promise((r) => child.on('close', r));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      await close;
      clearTimeout(timer);
    }
  if (worker.pid) {
    try {
      process.kill(-worker.pid, 'SIGTERM');
    } catch {
      /* already exited */
    }
  }
  await new Promise((r) => setTimeout(r, 500));
  rmSync(root, { recursive: true, force: true });
}

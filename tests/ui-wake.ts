import { WebSocketServer, WebSocket } from 'ws';
// Browser checks against a local deterministic relay peer; no model calls.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const artifacts = process.env.COC_ARTIFACT_DIR || '.local/wake-ui';
mkdirSync(artifacts, { recursive: true });
let admin = false,
  online = false,
  override: string | undefined,
  wakes = 0,
  projectReads = 0;
const agentUrl = 'https://wake.example/agent';
const server = createServer(async (req, res) => {
  const path = new URL(req.url!, 'http://local').pathname;
  if (path.startsWith('/api/v1/')) {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-CoC-Demand', '1');
    const host = {
      id: 'host',
      name: '开发服务器',
      version: 2,
      disabled: false,
      agentWakeUrl: agentUrl,
      ...(override === undefined ? {} : { wakeUrlOverride: override }),
    };
    let result: unknown = {};
    if (path === '/api/v1/auth/me') {
      if (!admin) res.statusCode = 401;
      result = admin ? { role: 'owner' } : { error: { code: 'UNAUTHORIZED' } };
    } else if (path === '/api/v1/auth/login') admin = true;
    else if (path === '/api/v1/admin/hosts') result = [host];
    else if (path === '/api/v1/admin/devices')
      result = { pending: [], credentials: [] };
    else if (path === '/api/v1/admin/api-keys') result = [];
    else if (path === '/api/v1/admin/hosts/host/wake-url') {
      let body = '';
      for await (const chunk of req) body += chunk;
      override = JSON.parse(body).wakeUrl ?? undefined;
      notify();
    } else if (path === '/api/v1/hosts')
      result = [
        {
          id: host.id,
          name: host.name,
          online,
          wakeConfigured: !!(override ?? agentUrl),
        },
      ];
    else if (path === '/api/v1/hosts/host/wake') {
      assert.equal(req.method, 'POST');
      wakes++;
      online = true;
      notify();
      result = { state: 'requested', retryAfterMs: 60000 };
    } else if (path === '/api/v1/hosts/host/probe')
      result = { online, confirmedAt: Date.now() };
    else if (path === '/api/v1/client/identity')
      result = { identity: 'wake-ui' };
    else if (path === '/api/v1/hosts/host/projects') {
      projectReads++;
      if (online)
        result = [{ id: 'project', name: '唤醒后项目', path: '/project' }];
      else {
        res.statusCode = 503;
        result = { error: { code: 'HOST_OFFLINE', message: 'Host offline' } };
      }
    } else if (path === '/api/v1/sessions' || path.endsWith('/threads'))
      result = { data: [], nextCursor: null };
    res.end(JSON.stringify(result));
    return;
  }
  const root = resolve('dist/web'),
    file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
  if (!file.startsWith(root + '/')) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.setHeader(
      'Content-Type',
      (
        {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
        } as Record<string, string>
      )[extname(file)] || 'application/octet-stream',
    );
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
});
const notifications = new WebSocketServer({ server });
let revision = 0;
function notify() {
  for (const ws of notifications.clients)
    if (ws.readyState === WebSocket.OPEN)
      ws.send(
        JSON.stringify({
          type: 'change',
          scope: 'registry',
          revision: ++revision,
        }),
      );
}
notifications.on('connection', (ws) =>
  ws.send(JSON.stringify({ type: 'subscribed', revision, demand: 1 })),
);
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const browser = await chromium.launch({ headless: true });
try {
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await page.getByLabel('所有者密钥').fill('local-test-owner');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('tab', { name: '待授权请求', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('唤醒 URL 开发服务器')).toHaveCount(0);
  await page.getByRole('tab', { name: '已授权设备', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toHaveAttribute(
    'id',
    'admin-panel-authorized',
  );
  await page
    .getByRole('tab', { name: '已授权设备', exact: true })
    .press('ArrowRight');
  await expect(
    page.getByRole('tab', { name: '服务器唤醒配置', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const settings = page
    .getByRole('table', { name: '服务器唤醒配置', exact: true })
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: /^开发服务器/ }) });
  await expect(
    settings.getByText('使用 Agent 配置', { exact: true }).first(),
  ).toBeVisible();
  const input = page.getByLabel('唤醒 URL 开发服务器');
  await input.fill('https://wake.example/admin');
  await page.getByRole('button', { name: '保存唤醒配置' }).click();
  await expect(settings.getByText('使用管理员配置')).toBeVisible();
  assert.equal(override, 'https://wake.example/admin');
  await page.screenshot({
    path: join(artifacts, 'admin-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('tab', { name: 'API Key 管理', exact: true }).click();
  await expect(page.getByRole('tabpanel')).toHaveAttribute(
    'id',
    'admin-panel-keys',
  );
  await page.getByRole('tab', { name: '管理会话', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '退出其他管理会话', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: '服务器唤醒配置', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await input.scrollIntoViewIfNeeded();
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    'no mobile overflow',
  );
  await page.screenshot({
    path: join(artifacts, 'admin-mobile.png'),
    fullPage: true,
  });
  await input.fill('');
  await page.getByRole('button', { name: '保存唤醒配置' }).click();
  await expect(settings.getByText('管理员已禁用唤醒')).toBeVisible();
  assert.equal(override, '');
  await settings
    .getByRole('button', { name: '使用 Agent 配置', exact: true })
    .click();
  await expect(input).toHaveValue(agentUrl);
  await expect(
    settings.getByText('使用 Agent 配置', { exact: true }).first(),
  ).toBeVisible();
  assert.equal(override, undefined);
  const cw = await browser.newPage({ viewport: { width: 390, height: 844 } });
  cw.on('pageerror', (error) => failures.push(error.message));
  await cw.goto(origin);
  await cw.getByRole('button', { name: '功能菜单' }).click();
  await cw.getByRole('button', { name: /^会话记录/ }).click();
  await cw.getByLabel('主机', { exact: true }).selectOption('host');
  await expect.poll(() => wakes).toBe(1);
  await expect(cw.getByLabel('项目', { exact: true })).toHaveValue('project');
  assert(projectReads > 0, 'catalog loaded after wake');
  await expect(
    cw.getByLabel('主机', { exact: true }).locator('option:checked'),
  ).toHaveText('开发服务器 · 在线');
  await cw.screenshot({
    path: join(artifacts, 'cw-online-mobile.png'),
    fullPage: true,
  });
  assert.deepEqual(failures, []);
  console.log(
    'PASS: administrator save/disable/Agent fallback, mobile layout, CW automatic wake and online catalog refresh',
  );
} finally {
  await browser.close();
  for (const ws of notifications.clients) ws.terminate();
  notifications.close();
  await new Promise<void>((done) => server.close(() => done()));
}

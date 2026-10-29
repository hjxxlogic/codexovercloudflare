import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
const artifacts = process.env.COC_ARTIFACT_DIR || '.local/billing-browser';
mkdirSync(artifacts, { recursive: true });
let requests = 0,
  admin = false,
  probes = 0,
  adminHostActive = false,
  dropAdminNotifications = false;
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://local');
  if (url.pathname.startsWith('/api/v1/')) {
    requests++;
    let value: unknown = {};
    if (url.pathname === '/api/v1/hosts')
      value = [{ id: 'host', name: 'Test host', online: true }];
    else if (url.pathname === '/api/v1/client/identity')
      value = { identity: 'billing-test' };
    else if (url.pathname === '/api/v1/hosts/host/projects')
      value = [{ id: 'project', name: 'test', path: '/workspace' }];
    else if (
      url.pathname === '/api/v1/sessions' ||
      url.pathname.endsWith('/threads')
    )
      value = { data: [], nextCursor: null };
    else if (url.pathname === '/api/v1/auth/me') {
      if (!admin) res.statusCode = 401;
      value = admin ? { role: 'owner' } : { error: { code: 'UNAUTHORIZED' } };
    } else if (url.pathname === '/api/v1/auth/login') admin = true;
    else if (url.pathname === '/api/v1/admin/devices')
      value = {
        pending: [],
        credentials: adminHostActive
          ? [
              {
                id: 'agent-grant',
                name: 'build-server',
                role: 'agent',
                hostId: 'host',
                created: 1,
              },
            ]
          : [],
      };
    else if (url.pathname === '/api/v1/admin/hosts')
      value = adminHostActive
        ? [{ id: 'host', name: 'build-server', version: 2, disabled: false }]
        : [];
    else if (url.pathname === '/api/v1/admin/api-keys')
      value = adminHostActive
        ? [
            {
              id: 'agent-key',
              name: 'fixture-agent-key',
              role: 'agent',
              hostId: 'host',
              created: 1,
            },
          ]
        : [];
    else if (
      ['/api/v1/admin/revoke', '/api/v1/admin/api-keys/revoke'].includes(
        url.pathname,
      )
    )
      adminHostActive = false;
    else if (url.pathname === '/api/v1/hosts/host/probe') {
      probes++;
      value = { online: true, confirmedAt: Date.now() };
    }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-CoC-Demand', '1');
    res.end(JSON.stringify(value));
    return;
  }
  const root = resolve('dist/web');
  const path = resolve(
    root,
    '.' + (url.pathname === '/' ? '/index.html' : url.pathname),
  );
  if (!path.startsWith(root + '/')) {
    res.writeHead(403).end();
    return;
  }
  try {
    res.setHeader(
      'Content-Type',
      extname(path) === '.js'
        ? 'text/javascript'
        : extname(path) === '.css'
          ? 'text/css'
          : 'text/html',
    );
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404).end();
  }
});
const notifications = new WebSocketServer({ server });
notifications.on('connection', (ws, req) => {
  if (dropAdminNotifications && req.url === '/ws/v1/admin') return;
  ws.send(JSON.stringify({ type: 'subscribed', revision: 0, demand: 1 }));
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.COC_BROWSER_PATH,
});
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /^会话记录/ }).click();
  await page.getByLabel('主机', { exact: true }).selectOption('host');
  await expect(page.getByLabel('项目', { exact: true })).toHaveValue('project');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.clock.install();
  const cwBaseline = requests;
  await page.clock.fastForward(86400000);
  await page.waitForTimeout(200);
  assert.equal(
    requests,
    cwBaseline,
    'CW must not poll during a simulated idle day',
  );
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '刷新状态', exact: true }),
  ).toBeEnabled();
  assert.equal(probes, 1);
  await page.screenshot({
    path: join(artifacts, 'cw-refresh-390.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .click();
  await page.keyboard.press('Escape');
  await page.getByLabel('所有者密钥').fill('billing-fixture-owner');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('table', { name: '待授权请求', exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(200);
  const adminBaseline = requests;
  await page.clock.fastForward(86400000);
  await page.waitForTimeout(200);
  assert.equal(
    requests,
    adminBaseline,
    'Administrator view must not poll during a simulated idle day',
  );
  // Neither refresh nor a successful mutation may depend on an arriving WS event.
  dropAdminNotifications = true;
  adminHostActive = true;
  const refresh = page.getByRole('button', { name: '刷新状态', exact: true });
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await page.getByRole('tab', { name: '已授权设备', exact: true }).click();
  await page.locator('.device-group > summary').click();
  await expect(
    page.getByRole('table', { name: '已授权设备', exact: true }),
  ).toContainText('build-server');
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('button', { name: '撤销 build-server', exact: true })
    .click();
  await expect(
    page.getByRole('table', { name: '已授权设备', exact: true }),
  ).toContainText('暂无已授权设备');
  await page.getByRole('tab', { name: '服务器唤醒配置', exact: true }).click();
  await expect(
    page.getByRole('table', { name: '服务器唤醒配置', exact: true }),
  ).toContainText('暂无服务器');

  adminHostActive = true;
  await refresh.click();
  await expect(refresh).toBeEnabled();
  await expect(
    page.getByRole('table', { name: '服务器唤醒配置', exact: true }),
  ).toContainText('build-server');
  await page.getByRole('tab', { name: 'API Key 管理', exact: true }).click();
  page.once('dialog', (dialog) => void dialog.accept());
  await page
    .getByRole('button', { name: '撤销 Key fixture-agent-key', exact: true })
    .click();
  await expect(
    page.getByRole('table', { name: 'API Key 管理', exact: true }),
  ).toContainText('暂无 API Key');
  await page.getByRole('tab', { name: '服务器唤醒配置', exact: true }).click();
  await expect(
    page.getByRole('table', { name: '服务器唤醒配置', exact: true }),
  ).toContainText('暂无服务器');
  assert.deepEqual(failures, []);
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(artifacts, 'admin-refresh-390.png'),
    fullPage: true,
  });
  console.log(
    JSON.stringify({
      scenario: 'A-CW',
      simulatedIdleHours: 24,
      cwPeriodicRequests: 0,
      adminPeriodicRequests: 0,
      manualProbes: probes,
      adminRefreshWithoutNotification: true,
      deviceRevokeRefreshesHosts: true,
      apiKeyRevokeRefreshesHosts: true,
      pageErrors: failures,
    }),
  );
} finally {
  await browser.close();
  for (const ws of notifications.clients) ws.terminate();
  notifications.close();
  await new Promise<void>((done) => server.close(() => done()));
}

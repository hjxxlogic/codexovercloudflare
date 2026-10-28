// Browser flow checks with synthetic identities; server authorization is tested separately.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { WebSocketServer } from 'ws';
const hosts = [
  { id: 'a', name: '服务器 A', online: false },
  { id: 'b', name: '服务器 B', online: false },
];
let paired = 0,
  restored = 0,
  adminLogins = 0;
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) {
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    try {
      const data = readFileSync(join('dist/web', file));
      res.setHeader(
        'Content-Type',
        extname(file) === '.js'
          ? 'text/javascript'
          : extname(file) === '.css'
            ? 'text/css'
            : 'text/html',
      );
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  const cookie = req.headers.cookie || '';
  const email = cookie.includes('access-test=admin')
    ? 'admin@example.test'
    : cookie.includes('access-test=other')
      ? 'other@example.test'
      : 'user@example.test';
  const isAdmin = cookie.includes('coc_admin=' + email);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const data = raw ? JSON.parse(raw) : {};
  const path = url.pathname.slice('/api/v1'.length);
  let result: unknown = {};
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-CoC-Demand', '1');
  if (path === '/auth/email')
    result = {
      enabled: true,
      email,
      accountId: email,
      autoAdmin: email.startsWith('admin'),
      legacy: [],
    };
  else if (path === '/auth/email/admin' && email.startsWith('admin')) {
    adminLogins++;
    res.setHeader('Set-Cookie', `coc_admin=${email}; HttpOnly; Path=/`);
  } else if (path === '/auth/login' && data.secret === 'test-owner-secret')
    res.setHeader('Set-Cookie', `coc_admin=${email}; HttpOnly; Path=/`);
  else if (path === '/auth/me') {
    if (!isAdmin) {
      res.statusCode = 401;
      result = { error: { code: 'UNAUTHORIZED', message: 'Login required' } };
    } else result = { role: 'owner' };
  } else if (path === '/hosts') result = email.startsWith('other') ? [] : hosts;
  else if (path === '/auth/email/restore') {
    restored++;
    res.setHeader(
      'Set-Cookie',
      `coc_web_${data.hostId}=test-web-token; HttpOnly; Path=/`,
    );
  } else if (path === '/auth/device/start') {
    paired++;
    res.statusCode = 400;
  } else if (path === '/client/identity') {
    if (!cookie.includes('coc_web_' + url.searchParams.get('hostId') + '=')) {
      res.statusCode = 401;
      result = { error: { code: 'UNAUTHORIZED', message: 'Restore first' } };
    } else result = { identity: email + ':' + url.searchParams.get('hostId') };
  } else if (path === '/admin/devices')
    result = {
      pending: [],
      credentials: [
        {
          id: 'emailGrant:test:a',
          role: 'web',
          name: 'user@example.test',
          hostId: 'a',
          created: Date.now(),
        },
      ],
    };
  else if (path === '/admin/hosts') result = hosts;
  else if (path === '/admin/api-keys') result = [];
  else if (path === '/auth/logout')
    res.setHeader('Set-Cookie', 'coc_admin=; Max-Age=0; Path=/');
  res.end(JSON.stringify(result));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws) =>
  ws.send(JSON.stringify({ type: 'subscribed', revision: 1 })),
);
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + (server.address() as any).port;
const browser = await chromium.launch({ headless: true });
const artifacts = process.env.COC_ARTIFACT_DIR || '.local/browser-access';
mkdirSync(artifacts, { recursive: true });
async function openHosts(page: Page) {
  await page.getByRole('button', { name: '功能菜单', exact: true }).click();
  await page.getByRole('button', { name: /^会话记录/ }).click();
  await expect(page.getByRole('region', { name: '连接设置' })).toBeVisible();
}
async function adminMode(page: Page) {
  await page.getByRole('button', { name: '功能菜单', exact: true }).click();
  await page
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .click();
  await page.getByRole('button', { name: '功能菜单', exact: true }).click();
}
try {
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await openHosts(page);
    await expect(page.getByText('当前邮箱：user@example.test')).toBeVisible();
    await expect(
      page
        .getByRole('combobox', { name: '主机', exact: true })
        .locator('option'),
    ).toHaveCount(3);
    await page
      .getByRole('combobox', { name: '主机', exact: true })
      .selectOption('a');
    await expect.poll(() => restored).toBe(i + 1);
    if (i === 1)
      await page.screenshot({
        path: join(artifacts, 'email-hosts.png'),
        fullPage: true,
      });
    await context.close();
  }
  assert.equal(
    paired,
    0,
    'Two fresh browsers restore authorization without pairing',
  );
  const adminContext = await browser.newContext();
  await adminContext.addCookies([
    { name: 'access-test', value: 'admin', url: origin },
  ]);
  const adminPage = await adminContext.newPage();
  await adminPage.goto(origin);
  await expect.poll(() => adminLogins).toBe(1);
  await adminMode(adminPage);
  await expect(
    adminPage.getByRole('tab', { name: '已授权设备', exact: true }),
  ).toBeVisible();
  await adminPage.getByRole('tab', { name: '已授权设备', exact: true }).click();
  await expect(
    adminPage.getByRole('rowheader', {
      name: 'user@example.test',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    adminPage.getByRole('textbox', { name: '所有者密钥' }),
  ).toHaveCount(0);
  await adminPage.screenshot({
    path: join(artifacts, 'email-admin.png'),
    fullPage: true,
  });
  const other = await browser.newContext();
  await other.addCookies([
    { name: 'access-test', value: 'other', url: origin },
  ]);
  const otherPage = await other.newPage();
  await otherPage.goto(origin);
  await adminMode(otherPage);
  await otherPage
    .getByLabel('所有者密钥', { exact: true })
    .fill('test-owner-secret');
  await otherPage.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    otherPage.getByRole('tab', { name: '已授权设备', exact: true }),
  ).toBeVisible();
  console.log(
    'PASS: fresh browsers restore email hosts; admin email signs in automatically; other email uses owner secret',
  );
} finally {
  await browser.close();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

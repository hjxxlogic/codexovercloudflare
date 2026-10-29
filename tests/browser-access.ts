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
  const guest = url.pathname === '/guest' || url.pathname.startsWith('/guest/');
  if (url.pathname === '/guest') {
    res.writeHead(307, { Location: '/guest/' + url.search });
    res.end();
    return;
  }
  if (guest) url.pathname = url.pathname.slice('/guest'.length) || '/';
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
    result =
      guest || cookie.includes('access-test=disabled')
        ? { enabled: false }
        : {
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
  } else if (path === '/hosts')
    result = guest
      ? cookie.includes('coc_guest_web_a=')
        ? [hosts[0]]
        : []
      : email.startsWith('other')
        ? []
        : hosts;
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
    if (
      !cookie.includes(
        (guest ? 'coc_guest_web_' : 'coc_web_') +
          url.searchParams.get('hostId') +
          '=',
      )
    ) {
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
    if (i === 1) {
      await page.getByRole('button', { name: '关闭面板', exact: true }).click();
      await page.getByRole('button', { name: '功能菜单', exact: true }).click();
      await expect(
        page.getByRole('button', { name: /^登出 user@example\.test/ }),
      ).toBeVisible();
      await page
        .getByRole('combobox', { name: '语言 / Language' })
        .selectOption('en');
      await expect(
        page.getByRole('button', { name: /^Sign out user@example\.test/ }),
      ).toBeVisible();
      await page.screenshot({
        path: join(artifacts, 'email-sign-out.png'),
        fullPage: true,
      });
      const logout = 'https://r.xlogic.cc/cdn-cgi/access/logout';
      await page.route(logout, (route) =>
        route.fulfill({ contentType: 'text/html', body: 'Signed out' }),
      );
      await page.getByRole('button', { name: /^Sign out/ }).click();
      await expect(page).toHaveURL(logout);
    }
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
  await adminPage
    .getByRole('button', { name: '功能菜单', exact: true })
    .click();
  await expect(adminPage.getByRole('button', { name: /^登出/ })).toHaveCount(0);
  await adminPage
    .getByRole('button', { name: '功能菜单', exact: true })
    .click();
  await expect(
    adminPage.getByRole('tab', { name: '已授权设备', exact: true }),
  ).toBeVisible();
  await adminPage.getByRole('tab', { name: '已授权设备', exact: true }).click();
  await adminPage.locator('.device-group > summary').click();
  await expect(
    adminPage.getByRole('rowheader', {
      name: /^user@example\.test/,
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
  const legacyContext = await browser.newContext();
  await legacyContext.addCookies([
    { name: 'access-test', value: 'disabled', url: origin },
  ]);
  const legacyPage = await legacyContext.newPage();
  await legacyPage.goto(origin);
  await legacyPage
    .getByRole('button', { name: '功能菜单', exact: true })
    .click();
  await expect(legacyPage.getByRole('button', { name: /^登出/ })).toHaveCount(
    0,
  );
  await legacyContext.close();
  const guestContext = await browser.newContext();
  await guestContext.addCookies([
    {
      name: 'coc_guest_web_a',
      value: 'test-web-token',
      url: origin + '/guest/',
    },
  ]);
  const guestPage = await guestContext.newPage();
  const guestRequests: string[] = [],
    guestSockets: string[] = [];
  guestPage.on('request', (request) =>
    guestRequests.push(new URL(request.url()).pathname),
  );
  guestPage.on('websocket', (socket) =>
    guestSockets.push(new URL(socket.url()).pathname),
  );
  await guestPage.goto(origin + '/guest');
  await expect(guestPage).toHaveURL(origin + '/guest/');
  await openHosts(guestPage);
  await expect(
    guestPage
      .getByRole('combobox', { name: '主机', exact: true })
      .locator('option'),
  ).toHaveCount(2);
  await expect
    .poll(() => guestSockets.includes('/guest/ws/v1/hosts/a'))
    .toBe(true);
  assert(guestRequests.some((path) => path.startsWith('/guest/assets/')));
  assert(guestRequests.includes('/guest/api/v1/auth/email'));
  assert(guestRequests.includes('/guest/api/v1/hosts'));
  assert(!guestRequests.some((path) => /^\/(assets|api|ws)\//.test(path)));
  await guestPage.screenshot({
    path: join(artifacts, 'guest-hosts.png'),
    fullPage: true,
  });
  await guestContext.close();
  console.log(
    'PASS: email hosts restore; admin login; bilingual CW sign-out; guest assets, API and WS stay under the public prefix',
  );
} finally {
  await browser.close();
  for (const ws of wss.clients) ws.terminate();
  wss.close();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
}

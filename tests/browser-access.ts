import {
  openNavigation,
  openSettings,
  selectHost,
} from './helpers/workspace-ui.ts';
import { encryptedFixture } from './helpers/encrypted-fixture.ts';
import { createHash } from 'node:crypto';
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
const restoredHosts: string[] = [];
let paired = 0,
  restored = 0,
  adminLogins = 0,
  claimed = false,
  claims = 0;
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
  const unclaimedBrowser = cookie.includes('unclaimed=test');
  const isAdmin = cookie.includes('coc_admin=' + email);
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const data = raw ? JSON.parse(raw) : {};
  const path = url.pathname.slice('/api/v1'.length);
  let result: unknown = {};
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('X-CoC-Demand', '1');
  res.setHeader('X-CoC-Delivery', '2');
  if (path === '/auth/email')
    result =
      guest || cookie.includes('access-test=disabled')
        ? { enabled: false }
        : {
            enabled: true,
            email,
            accountId: email,
            autoAdmin: email.startsWith('admin'),
            legacy:
              unclaimedBrowser && !claimed
                ? [{ hostId: 'a', name: '无邮箱授权' }]
                : [],
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
      : unclaimedBrowser
        ? claimed
          ? [hosts[0]]
          : []
        : email.startsWith('other')
          ? []
          : hosts;
  else if (
    path === '/auth/email/migrate' &&
    unclaimedBrowser &&
    data.hostId === 'a'
  ) {
    claimed = true;
    claims++;
  } else if (path === '/auth/email/restore') {
    restored++;
    restoredHosts.push(data.hostId);
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
    } else
      result = {
        identity: createHash('sha256')
          .update(email + ':' + url.searchParams.get('hostId'))
          .digest('hex'),
      };
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
wss.on('connection', (ws, req) => {
  if (encryptedFixture(ws, req)) return;
  ws.send(JSON.stringify({ type: 'subscribed', revision: 1 }));
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = 'http://127.0.0.1:' + (server.address() as any).port;
const browser = await chromium.launch({ headless: true });
const artifacts = process.env.COC_ARTIFACT_DIR || '.local/browser-access';
mkdirSync(artifacts, { recursive: true });
async function openHosts(page: Page) {
  await openNavigation(page);
  const heading = page.getByRole('button', { name: '选择主机', exact: true });
  if ((await heading.getAttribute('aria-expanded')) !== 'true')
    await heading.click();
}
async function adminMode(page: Page) {
  await openSettings(page);
  await page
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .click();
  await page.keyboard.press('Escape');
}
try {
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await openHosts(page);
    await expect(page.getByText('user', { exact: true })).toBeVisible();
    await expect(
      page.getByLabel('主机列表', { exact: true }).getByRole('button'),
    ).toHaveCount(2);
    await selectHost(page, /服务器 A/);
    await expect.poll(() => restored).toBe(i * hosts.length + 1);
    await selectHost(page, /服务器 B/);
    await expect.poll(() => restored).toBe((i + 1) * hosts.length);
    await selectHost(page, /服务器 A/);
    assert.deepEqual(
      restoredHosts.slice(i * hosts.length).sort(),
      ['a', 'b'],
      'Each selected host restores its authorization once; revisiting reuses its credential',
    );
    if (i === 1)
      await page.screenshot({
        path: join(artifacts, 'email-hosts.png'),
        fullPage: true,
      });
    if (i === 1) {
      await page.keyboard.press('Escape');
      await openSettings(page);
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
      const logout = origin + '/cdn-cgi/access/logout';
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
  await openSettings(adminPage);
  await expect(adminPage.getByRole('button', { name: /^登出/ })).toHaveCount(0);
  await adminPage.keyboard.press('Escape');
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

  const accessDisabledContext = await browser.newContext();
  await accessDisabledContext.addCookies([
    { name: 'access-test', value: 'disabled', url: origin },
  ]);
  const accessDisabledPage = await accessDisabledContext.newPage();
  await accessDisabledPage.goto(origin);
  await openSettings(accessDisabledPage);
  await expect(
    accessDisabledPage.getByRole('button', { name: /^登出/ }),
  ).toHaveCount(0);
  await accessDisabledContext.close();
  const unclaimedContext = await browser.newContext();
  await unclaimedContext.addCookies([
    { name: 'unclaimed', value: 'test', url: origin },
  ]);
  const unclaimedPage = await unclaimedContext.newPage();
  await unclaimedPage.goto(origin);
  await openHosts(unclaimedPage);
  await unclaimedPage
    .getByRole('button', { name: '申请授权', exact: true })
    .first()
    .click();
  const claim = unclaimedPage.getByRole('button', { name: /^关联旧授权：/ });
  await expect(claim).toBeVisible();
  await unclaimedPage.screenshot({
    path: join(artifacts, 'unbound-email-claim.png'),
    fullPage: true,
  });
  assert.equal(
    claims,
    0,
    'An unbound credential is never associated automatically',
  );
  unclaimedPage.once('dialog', (dialog) => dialog.accept());
  await claim.click();
  await expect.poll(() => claims).toBe(1);
  await expect(claim).toHaveCount(0);
  await openHosts(unclaimedPage);
  await expect(
    unclaimedPage.getByLabel('主机列表', { exact: true }).getByRole('button'),
  ).toHaveCount(1);
  await unclaimedContext.close();
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
    guestPage.getByLabel('主机列表', { exact: true }).getByRole('button'),
  ).toHaveCount(1);
  await expect
    .poll(() => guestSockets.includes('/guest/ws/v1/channel/a'))
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

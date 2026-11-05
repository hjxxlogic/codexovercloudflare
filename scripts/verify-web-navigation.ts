// Web-only r2 acceptance. Does not create/attach sessions, send prompts or start terminals.
import assert from 'node:assert/strict';
import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { chromium, expect } from '@playwright/test';
import { version } from '../package.json';

const { values } = parseArgs({
  options: {
    'access-config': { type: 'string' },
    'owner-secret-file': { type: 'string' },
    host: { type: 'string' },
    output: { type: 'string' },
  },
});
const origin = 'https://r2.xlogic.cc';
function privateFile(path: string | undefined) {
  assert(path, 'Private configuration path is required');
  assert.equal(statSync(path).mode & 0o077, 0, 'Credentials require mode 0600');
  return readFileSync(path, 'utf8');
}
const access = JSON.parse(privateFile(values['access-config']));
assert.deepEqual(
  access.origins,
  [origin],
  'r2-only Access credentials required',
);
const admission = {
  'CF-Access-Client-Id': access.clientId,
  'CF-Access-Client-Secret': access.clientSecret,
};
const secret = privateFile(values['owner-secret-file']).trim();
assert(values.host, 'An existing isolated test host is required');
assert(values.output, 'An ignored local output directory is required');
const output = values.output;
mkdirSync(output, { recursive: true });
const base = origin + '/guest';
let owner = '';
async function control(
  path: string,
  data?: object,
  extra: Record<string, string> = {},
) {
  const response = await fetch(base + '/api/v1' + path, {
    method: data ? 'POST' : 'GET',
    headers: {
      ...admission,
      Origin: origin,
      'Content-Type': 'application/json',
      ...extra,
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  assert(response.ok, `Control request ${path} failed (${response.status})`);
  return { response, data: (await response.json()) as any };
}
const ownerHeaders = () => ({ Authorization: 'Bearer ' + owner });
const name = 'web-navigation-' + version + '-' + randomUUID();
const errors: string[] = [];
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let enrolled = false;
let cleanupVerified = false;
try {
  owner = (await control('/auth/login', { kind: 'cli', secret })).data.token;
  const start = await control('/auth/device/start', {
    role: 'web',
    name,
    requestedHostId: values.host,
  });
  enrolled = true;
  await control('/admin/approve', { id: start.data.id }, ownerHeaders());
  const approvalCookie = start.response.headers
    .get('set-cookie')!
    .split(';')[0];
  const poll = await control(
    '/auth/device/poll',
    { id: start.data.id, pollSecret: start.data.pollSecret },
    { Cookie: approvalCookie },
  );
  const cookie = poll.response.headers.get('set-cookie')!.split(';')[0];
  const separator = cookie.indexOf('=');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    extraHTTPHeaders: admission,
  });
  await context.route('**/*', (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  await context.addCookies([
    {
      name: cookie.slice(0, separator),
      value: cookie.slice(separator + 1),
      url: origin,
      httpOnly: true,
      sameSite: 'Strict',
    },
  ]);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(base + '/');
  const target = (
    await control('/hosts', undefined, { Cookie: cookie })
  ).data.find((item: any) => item.id === values.host);
  assert(target, 'Isolated test host must remain authorized');
  await page
    .locator('#navigation-hosts .navigation-option')
    .filter({ hasText: target.name })
    .click();
  await expect(
    page.getByRole('button', { name: '选择项目', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.getByRole('button', { name: '选择会话', exact: true }),
  ).toBeDisabled();
  await expect(
    page.locator('#navigation-projects .navigation-option'),
  ).not.toHaveCount(0);
  const refreshProject = page.getByRole('button', {
    name: '刷新项目',
    exact: true,
  });
  const newProject = page.getByRole('button', {
    name: '新建项目',
    exact: true,
  });
  await expect(refreshProject).toBeVisible();
  assert(
    (await refreshProject.boundingBox())!.x <
      (await newProject.boundingBox())!.x,
  );
  await refreshProject.click();
  await page.locator('#navigation-projects .navigation-option').first().click();
  await expect(
    page.getByRole('button', { name: '选择会话', exact: true }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.locator('.navigation-level > h2 > button[aria-expanded="true"]'),
  ).toHaveCount(1);
  await expect(page.locator('.navigation-footer a')).toHaveCount(0);
  for (const id of ['hosts', 'projects']) {
    assert(
      (await page.locator(`#navigation-${id}-heading`).boundingBox())!.height <=
        42,
    );
  }
  assert.deepEqual(
    await page
      .locator('.workspace-toolbar > button')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('aria-label')),
      ),
    ['文件浏览器', 'Terminal', '命令输出', '刷新状态', '信息'],
  );
  await expect(
    page.getByRole('button', { name: '功能菜单', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^会话记录/ })).toHaveCount(0);
  await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '文件浏览器', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '上传 / 传输', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '工作区文件', exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '关闭文件浏览器', exact: true })
    .click();
  await page.getByRole('button', { name: '命令输出', exact: true }).click();
  await expect(page.locator('.unified-output')).toBeVisible();
  await page.getByRole('button', { name: '信息', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '会话详情', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.unified-output')).not.toBeVisible();
  const informationDialog = page.getByRole('dialog', {
    name: '会话详情',
    exact: true,
  });
  await informationDialog.locator('.session-details').evaluate((node) => {
    const content = document.createElement('p');
    content.textContent = 'Long information '.repeat(1000);
    node.appendChild(content);
    node.scrollTop = node.scrollHeight;
  });
  const closeInformation = page.getByRole('button', {
    name: '关闭信息',
    exact: true,
  });
  const closeBounds = (await closeInformation.boundingBox())!;
  assert(
    closeBounds.y >= 0 &&
      closeBounds.y + closeBounds.height <= page.viewportSize()!.height,
  );
  await page.keyboard.press('Escape');
  await expect(informationDialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '信息', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: '命令输出', exact: true }).click();
  await page.screenshot({
    path: join(output, 'online-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '关闭会话导航', exact: true }).click();
  await page.getByRole('button', { name: '打开会话导航', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(
    page.getByText('网站版本 ' + version, { exact: true }),
  ).toBeVisible();
  await page.getByLabel('全站主题', { exact: true }).selectOption('dark');
  await page.screenshot({
    path: join(output, 'online-settings-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByLabel('全站主题', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开会话导航', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '会话导航', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: join(output, 'online-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(
    page.getByRole('button', { name: '设置', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .click();
  await page.getByLabel('所有者密钥', { exact: true }).fill(secret);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('tablist', { name: '管理功能', exact: true }),
  ).toBeVisible();
  await page.getByRole('tab', { name: '已授权设备', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '已授权设备', exact: true }),
  ).toBeVisible();
  // Screenshots omit production device names and identifiers.
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.screenshot({
    path: join(output, 'online-admin-settings.png'),
    fullPage: true,
    animations: 'disabled',
    mask: [page.locator('.admin-tabs')],
  });
  assert.deepEqual(errors, []);
  await context.close();
} finally {
  await browser?.close();
  if (enrolled && owner) {
    const devices = (await control('/admin/devices', undefined, ownerHeaders()))
      .data.credentials;
    const own = devices.filter(
      (device: any) =>
        device.name === name &&
        device.role === 'web' &&
        device.hostId === values.host,
    );
    assert(own.length <= 1, 'Temporary credential identity must be unique');
    for (const device of own)
      await control('/admin/revoke', { id: device.id }, ownerHeaders());
    const remaining = (
      await control('/admin/devices', undefined, ownerHeaders())
    ).data.credentials;
    cleanupVerified = !remaining.some((device: any) => device.name === name);
    assert(cleanupVerified, 'Temporary Web credential cleanup failed');
  }
}
writeFileSync(
  join(output, 'web-verification.json'),
  JSON.stringify(
    {
      passed: true,
      version,
      origin,
      errors,
      cleanupVerified,
      scope:
        'Web UI only; no session attach/create, prompt, terminal process or Agent restart',
      checks: [
        'compact hierarchical navigation and five toolbar actions',
        'persistent project refresh before new project',
        'modal information with visible close button',
        'merged files and transfers',
        'exclusive right panels',
        'settings and theme',
        'mobile drawer and overflow',
        'admin login and left navigation',
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'PASS: r2 Web UI ' +
    version +
    '; temporary Web credential removed; no sessions or Agent processes changed',
);

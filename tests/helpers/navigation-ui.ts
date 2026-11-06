import assert from 'node:assert/strict';
import { fixtureRoutes } from './encrypted-fixture.ts';
import { join } from 'node:path';
import { expect, type Browser } from '@playwright/test';

export async function navigationUI(
  browser: Browser,
  origin: string,
  artifacts: string,
  calls: () => number,
  emitState: (state: string) => void | Promise<void>,
  observer: {
    takeover: () => void;
    append: (text: string) => void;
    resume: () => void;
  },
) {
  const bytes = Buffer.from(
    '# Unified files\n\n| Name | Result |\n| --- | --- |\n| preview | ready |\n\n```ts\nconst value = 42;\n```\n' +
      '\n\nLong preview content for scrolling.'.repeat(160),
  );
  fixtureRoutes.route('**/api/v1/hosts/sample/files', async (route) => {
    const data = route.request().postDataJSON();
    const headers = { 'X-CoC-Demand': '1', 'X-CoC-Delivery': '2' };
    if (data.operation === 'list')
      return route.fulfill({
        headers,
        json: {
          entries: [
            { name: 'report.md', directory: false, size: bytes.length },
          ],
          next: null,
          writable: true,
          maxSize: 20971520,
        },
      });
    if (data.operation === 'read')
      return route.fulfill({
        headers,
        json: {
          data: bytes.toString('base64'),
          size: bytes.length,
          offset: bytes.length,
          version: 'navigation-file-v1',
        },
      });
    return route.continue();
  });
  let attachMode: 'normal' | 'conflict' = 'normal';
  let takeoverCalls = 0;
  let transientFailures = 0;
  fixtureRoutes.route('**/api/v1/sessions/sample~session/attach', (route) => {
    if (transientFailures > 0) {
      transientFailures--;
      return route.fulfill({
        status: 503,
        json: { error: { code: 'HOST_OFFLINE', message: 'Temporary loss' } },
      });
    }
    return attachMode === 'conflict'
      ? route.fulfill({
          status: 409,
          json: {
            error: { code: 'SESSION_BUSY', message: 'Already controlled' },
          },
        })
      : route.continue();
  });
  fixtureRoutes.route('**/api/v1/sessions/sample~session/takeover', (route) => {
    takeoverCalls++;
    attachMode = 'normal';
    return route.fulfill({ json: { ticket: 'synthetic-ticket' } });
  });
  let canManage = true;
  fixtureRoutes.route(
    '**/api/v1/hosts/sample/project-management',
    async (route) =>
      route.fulfill({
        json: {
          revision: 1,
          canManage,
          projects: [
            { id: 'project', name: '示例项目', path: '/workspace/example' },
          ],
        },
        headers: { 'X-CoC-Demand': '1', 'X-CoC-Delivery': '2' },
      }),
  );
  fixtureRoutes.route('**/api/v1/hosts/second/projects', (route) =>
    route.fulfill({ json: [] }),
  );
  fixtureRoutes.route('**/api/v1/hosts/second/project-management', (route) =>
    route.fulfill({ json: { revision: 1, projects: [], canManage: true } }),
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await context.route('**/api/v1/auth/email', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        email: 'alice.smith@example.test',
        accountId: 'navigation-account',
        legacy: [],
      },
    }),
  );
  let hostOnline = true;
  await context.route('**/api/v1/hosts', (route) =>
    route.fulfill({
      headers: { 'X-CoC-Demand': '1', 'X-CoC-Delivery': '2' },
      json: [
        { id: 'sample', name: '示例服务器', online: hostOnline },
        { id: 'second', name: '另一台服务器', online: false },
      ],
    }),
  );
  await context.addInitScript({
    content: `
    Object.defineProperty(navigator, 'clipboard', {value: {
      writeText: async (text) => { window.__copied = text; },
      write: async (items) => { window.__copied = await (await items[0].getType('text/plain')).text(); },
    }});
  `,
  });
  const page = await context.newPage();
  const insideViewport = async (
    locator: import('@playwright/test').Locator,
  ) => {
    await expect(locator).toBeVisible();
    const box = (await locator.boundingBox())!;
    const viewport = page.viewportSize()!;
    assert(
      box.x >= 0 &&
        box.y >= 0 &&
        box.x + box.width <= viewport.width &&
        box.y + box.height <= viewport.height,
      'operation remains inside viewport',
    );
  };
  const failures: string[] = [];
  page.on('pageerror', (error) => {
    failures.push(error.message);
    console.error('Web UI error:', error.message);
  });
  const openSettings = async () => {
    const settings = page.getByRole('button', { name: '设置', exact: true });
    if (!(await settings.isVisible()))
      await page
        .getByRole('button', { name: '打开会话导航', exact: true })
        .click();
    await settings.click();
    await expect(
      page.getByRole('region', { name: '设置', exact: true }),
    ).toBeVisible();
  };
  const noOverflow = async () =>
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      'no page horizontal overflow',
    );
  await page.goto(origin);
  await expect(page.locator('.navigation-username')).toHaveText('alice.smith');
  await expect(page.locator('.navigation-footer a')).toHaveCount(0);
  await expect(page.locator('.navigation-footer button')).toHaveCount(1);
  const chooseHost = page.getByRole('button', {
    name: '选择主机',
    exact: true,
  });
  const chooseProject = page.getByRole('button', {
    name: '选择项目',
    exact: true,
  });
  const chooseSession = page.getByRole('button', {
    name: '选择会话',
    exact: true,
  });
  await expect(chooseProject).toBeDisabled();
  await expect(chooseSession).toBeDisabled();
  await expect(
    page.locator('#navigation-hosts .navigation-option').first(),
  ).toBeVisible();
  await page.getByRole('button', { name: '申请授权', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '连接远程服务器', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('设备名称', { exact: true })).toBeVisible();
  await page.screenshot({
    path: join(artifacts, 'hierarchy-hosts-authorization.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '申请授权', exact: true }).click();
  await page.getByRole('button', { name: /示例服务器.*在线/ }).click();
  await expect(chooseProject).toHaveAttribute('aria-expanded', 'true');
  await expect(chooseSession).toBeDisabled();
  await expect(
    page.locator('#navigation-projects .navigation-option'),
  ).not.toHaveCount(0);
  const projectRefresh = page.getByRole('button', {
    name: '刷新项目',
    exact: true,
  });
  const newProject = page.getByRole('button', {
    name: '新建项目',
    exact: true,
  });
  await expect(projectRefresh).toBeVisible();
  assert(
    (await projectRefresh.boundingBox())!.x <
      (await newProject.boundingBox())!.x,
  );
  await projectRefresh.click();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await expect(
    page.getByLabel('远程目录绝对路径', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel('远程目录绝对路径', { exact: true }),
  ).toHaveValue('/workspace/');
  await page
    .getByLabel('远程目录绝对路径', { exact: true })
    .fill('/workspace/new-project');
  await page.getByLabel('项目显示名', { exact: true }).fill('New UI project');
  await page.screenshot({
    path: join(artifacts, 'hierarchy-projects-new.png'),
    fullPage: true,
    animations: 'disabled',
  });
  canManage = false;
  await page.getByRole('button', { name: '刷新项目', exact: true }).click();
  await expect(
    page.getByText('仅 Agent 管理员邮箱或系统管理员可以更改项目登记。'),
  ).toBeVisible();
  await expect(
    page.getByLabel('远程目录绝对路径', { exact: true }),
  ).not.toBeVisible();
  canManage = true;
  await projectRefresh.click();
  await expect(
    page.getByLabel('远程目录绝对路径', { exact: true }),
  ).toHaveValue('/workspace/new-project');
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await page
    .locator('#navigation-projects .navigation-option')
    .filter({ hasText: '示例项目' })
    .click();
  await expect(chooseSession).toHaveAttribute('aria-expanded', 'true');
  await expect(
    page.locator('.navigation-level > h2 > button[aria-expanded="true"]'),
  ).toHaveCount(1);
  await page
    .locator('#navigation-sessions')
    .getByRole('button', { name: /进行中的对话/ })
    .click();
  await expect(page.getByLabel('任务内容')).toBeVisible();
  await expect(
    page.locator('.happier-session-heading .happier-session-title'),
  ).toHaveCount(0);
  await expect(
    page.locator('.happier-session-heading .workspace-context'),
  ).toHaveCount(0);
  await expect(page.locator('.connection-notice')).toHaveCount(0);
  for (const [selector, expected] of [
    ['.user-message', '示例任务'],
    ['.assistant-message[data-event-seq="5"]', '[下载报告]('],
  ]) {
    const message = page.locator(selector).first();
    const action = message.getByRole('button', {
      name: '复制消息',
      exact: true,
    });
    await page.getByLabel('任务内容').focus();
    await page.mouse.move(0, 0);
    await expect(action).toHaveCSS('opacity', '0');
    const height = (await message.boundingBox())!.height;
    await message.hover();
    await expect(action).toHaveCSS('opacity', '1');
    assert.equal(
      (await message.boundingBox())!.height,
      height,
      'copy does not change message height',
    );
    await action.click();
    await expect
      .poll(() => page.evaluate(() => (window as any).__copied))
      .toContain(expected);
    assert.equal(
      (await message.boundingBox())!.height,
      height,
      'copy feedback does not change message height',
    );
  }
  const longMessage = page.locator('.assistant-message[data-event-seq="6"]');
  await longMessage
    .getByRole('button', { name: '复制消息', exact: true })
    .focus();
  await longMessage
    .getByRole('button', { name: '复制消息', exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => ((window as any).__copied || '').length), {
      timeout: 20000,
    })
    .toBeGreaterThan(131000);
  const copied = await page.evaluate(() => (window as any).__copied as string);
  assert(copied.startsWith('第一段第二段') && copied.endsWith('完整正文'));
  await longMessage.hover();
  await insideViewport(
    longMessage.getByRole('button', { name: '复制消息', exact: true }),
  );
  for (const heading of [chooseHost, chooseProject]) {
    assert(
      (await heading.boundingBox())!.height <= 42,
      'collapsed level is a compact single row',
    );
    assert(
      await heading
        .locator('span')
        .evaluate((node) => getComputedStyle(node).display === 'flex'),
    );
  }
  const tools = page.locator('.conversation .tool-group').first();
  const summary = tools.locator(':scope > summary');
  assert(
    await summary.evaluate(
      (node) => getComputedStyle(node).whiteSpace === 'nowrap',
    ),
  );
  await summary.click();
  const tool = tools.locator('.tool-output').first();
  const toolSummary = tool.locator(':scope > summary');
  assert(
    await toolSummary.evaluate(
      (node) =>
        node.clientHeight <= 34 &&
        getComputedStyle(node).whiteSpace === 'nowrap',
    ),
  );
  await toolSummary.click();
  const copy = tool.locator('.copy-action').first();
  await page.getByLabel('任务内容').focus();
  await page.mouse.move(0, 0);
  await expect(copy).toHaveCSS('opacity', '0');
  await tool.hover();
  await expect(copy).toHaveCSS('opacity', '1');
  await tool.locator('pre').click();
  await page.mouse.move(0, 0);
  await expect(copy).toHaveCSS('opacity', '1');
  await copy.focus();
  await expect(copy).toBeFocused();
  await toolSummary.click();
  await summary.click();
  await expect(page.getByRole('log')).toContainText('示例任务');
  await page.getByLabel('任务内容').fill('统一导航保留草稿');
  const before = calls();
  await expect(page.getByRole('button', { name: /^会话记录/ })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '功能菜单', exact: true }),
  ).toHaveCount(0);
  assert.deepEqual(
    await page
      .locator('.workspace-toolbar > button')
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute('aria-label')),
      ),
    ['文件浏览器', 'Terminal', '命令输出', '刷新状态', '信息'],
  );
  const conversationX = (await page.locator('.conversation').boundingBox())!.x;
  await page.getByRole('button', { name: '关闭会话导航', exact: true }).click();
  await expect(chooseHost).not.toBeVisible();
  assert(
    (await page.locator('.conversation').boundingBox())!.x < conversationX,
    'collapse releases navigation width',
  );
  await page.getByRole('button', { name: '打开会话导航', exact: true }).click();
  await page
    .getByLabel('搜索会话', { exact: true })
    .fill('no-matching-session');
  await expect(page.getByText('没有匹配的已加载会话。')).toBeVisible();
  await page.getByLabel('搜索会话', { exact: true }).fill('');
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.terminal-shell')).toBeVisible();
  await page
    .locator('.terminal-shell')
    .evaluate((node) => node.setAttribute('data-retained', 'yes'));
  await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '文件浏览器', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.terminal-shell')).toBeVisible();
  await page.getByRole('button', { name: /report.md/ }).click();
  const preview = page.getByRole('region', { name: '文件预览', exact: true });
  await expect(
    preview.getByRole('heading', { name: 'Unified files', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.unified-files .workbench-preview')).toHaveCount(
    0,
  );
  await expect(
    page.locator('.unified-preview .workbench-preview'),
  ).toBeVisible();
  await page.getByLabel('筛选已加载项', { exact: true }).fill('report');
  await page
    .getByRole('button', { name: '关闭文件浏览器', exact: true })
    .click();
  await expect(
    page.getByRole('region', { name: '文件浏览器', exact: true }),
  ).not.toBeVisible();
  await expect(preview).toBeVisible();
  await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
  await expect(page.getByLabel('筛选已加载项', { exact: true })).toHaveValue(
    'report',
  );
  await expect(preview.locator('table')).toContainText('ready');
  await expect(preview.locator('code')).toContainText('const value = 42');
  await noOverflow();
  await page.screenshot({
    path: join(artifacts, 'navigation-files.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await preview.locator(':scope > .markdown').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await insideViewport(
    preview.getByRole('button', { name: '关闭预览', exact: true }),
  );
  await insideViewport(
    preview.getByRole('button', { name: '源码', exact: true }),
  );
  await insideViewport(
    preview.getByRole('button', { name: '下载', exact: true }),
  );
  await preview.getByRole('button', { name: '全屏', exact: true }).click();
  await preview.locator(':scope > .markdown').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await insideViewport(
    preview.getByRole('button', { name: '退出全屏', exact: true }),
  );
  await insideViewport(
    preview.getByRole('button', { name: '关闭预览', exact: true }),
  );
  await preview.getByRole('button', { name: '退出全屏', exact: true }).click();
  const closePreview = preview.getByRole('button', {
    name: '关闭预览',
    exact: true,
  });
  await closePreview.hover();
  await expect(
    page.getByRole('tooltip', { name: '关闭预览', exact: true }),
  ).toBeVisible();
  assert.equal(
    await closePreview.getAttribute('aria-describedby'),
    await page
      .getByRole('tooltip', { name: '关闭预览', exact: true })
      .getAttribute('id'),
  );
  await page.mouse.move(0, 0);
  await expect(
    page.getByRole('tooltip', { name: '关闭预览', exact: true }),
  ).not.toBeVisible();
  await closePreview.focus();
  await expect(
    page.getByRole('tooltip', { name: '关闭预览', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('tooltip', { name: '关闭预览', exact: true }),
  ).not.toBeVisible();
  assert.equal(await closePreview.textContent(), '');
  await closePreview.click();
  await expect(
    page.getByRole('region', { name: '文件浏览器', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('筛选已加载项', { exact: true })).toHaveValue(
    'report',
  );
  await page.getByRole('button', { name: '上传 / 传输', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '工作区文件', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('dialog', { name: '工作区文件' })).toHaveCount(0);
  await page.getByRole('button', { name: '命令输出', exact: true }).click();
  await expect(
    page.getByRole('region', { name: '文件浏览器', exact: true }),
  ).not.toBeVisible();
  await expect(page.locator('.unified-output')).toBeVisible();
  await expect(page.locator('.unified-output')).toContainText('echo example-2');
  await page.getByRole('button', { name: '信息', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '会话详情', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.unified-output')).not.toBeVisible();
  const information = page.getByRole('dialog', {
    name: '会话详情',
    exact: true,
  });
  await information.getByText('会话标识', { exact: true }).click();
  await information.getByText('本机存储', { exact: true }).click();
  await page.screenshot({
    path: join(artifacts, 'information-dialog.png'),
    animations: 'disabled',
  });
  await information.locator('.session-details-content').evaluate((node) => {
    const extra = document.createElement('p');
    extra.textContent = '长信息内容 '.repeat(2000);
    node.appendChild(extra);
    node.scrollTop = node.scrollHeight;
  });
  await insideViewport(
    information.getByRole('button', { name: '关闭信息', exact: true }),
  );
  await insideViewport(
    information.getByRole('button', { name: '结束会话', exact: true }),
  );
  await page.screenshot({
    path: join(artifacts, 'information-dialog-long.png'),
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(information).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '信息', exact: true }),
  ).toBeFocused();
  await page.getByRole('button', { name: '命令输出', exact: true }).click();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.terminal-shell')).not.toBeVisible();
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await expect(page.locator('.terminal-shell')).toHaveAttribute(
    'data-retained',
    'yes',
  );
  await openSettings();
  await expect(
    page.getByRole('heading', { name: '外观', exact: true }),
  ).toBeVisible();
  await page.getByLabel('全站主题', { exact: true }).selectOption('dark');
  for (const label of [
    '查找下一个',
    '启用页面通知',
    '快捷操作',
    '导出已加载对话',
    '切换到管理员模式',
  ]) {
    const action = page
      .getByRole('region', { name: '设置', exact: true })
      .getByRole('button', { name: label, exact: true });
    await expect(action.locator('svg')).toHaveCount(1);
    await expect(action).toContainText(label);
  }
  await page.getByLabel('密度', { exact: true }).selectOption('compact');
  await page.getByLabel('工作面板宽度', { exact: true }).fill('520');
  await page.getByLabel('Terminal 高度', { exact: true }).fill('300');
  await page.screenshot({
    path: join(artifacts, 'navigation-settings.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await expect(page.getByLabel('任务内容')).toHaveValue('统一导航保留草稿');
  await expect(page.locator('.terminal-shell')).toHaveAttribute(
    'data-retained',
    'yes',
  );
  assert.equal(
    calls(),
    before,
    'navigation/settings/panels do not reattach session',
  );
  await page.getByRole('button', { name: 'Terminal', exact: true }).click();
  await page.screenshot({
    path: join(artifacts, 'navigation-desktop-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await openSettings();
  await page.getByLabel('全站主题', { exact: true }).selectOption('light');
  await page.getByRole('button', { name: '返回会话', exact: true }).click();
  await noOverflow();
  await page.screenshot({
    path: join(artifacts, 'navigation-desktop-light.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await chooseProject.click();
  await page
    .locator('#navigation-projects .navigation-option')
    .filter({ hasText: '第二项目' })
    .click();
  await page
    .locator('#navigation-sessions')
    .getByRole('button', { name: /第二项目对话/ })
    .click();
  await expect(page.getByLabel('任务内容')).toHaveValue('');
  attachMode = 'conflict';
  await chooseProject.click();
  await page
    .locator('#navigation-projects .navigation-option')
    .filter({ hasText: '示例项目' })
    .click();
  await page
    .locator('#navigation-sessions')
    .getByRole('button', { name: /进行中的对话/ })
    .click();
  const continuation = page
    .locator('.readonly-hint')
    .getByRole('button', { name: '继续对话', exact: true });
  await expect(continuation).toBeVisible();
  await expect(page.locator('.readonly-hint')).toContainText('其他页面');
  assert.equal(takeoverCalls, 0, 'never take over automatically');
  const firstObserverAttaches = calls();
  observer.append('首次以只读方式打开也能补回消息');
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByText('首次以只读方式打开也能补回消息', { exact: true }),
  ).toBeVisible();
  assert.equal(
    calls(),
    firstObserverAttaches,
    'first observer recovery does not attach',
  );
  assert.equal(
    takeoverCalls,
    0,
    'first observer recovery does not take control',
  );
  observer.resume();

  page.once('dialog', (dialog) => {
    assert(dialog.message().includes('原页面将无法继续操作'));
    void dialog.dismiss();
  });
  await continuation.click();
  assert.equal(takeoverCalls, 0, 'cancel preserves original controller');
  await page.screenshot({
    path: join(artifacts, 'continue-elsewhere.png'),
    animations: 'disabled',
  });
  page.once('dialog', (dialog) => dialog.accept());
  await continuation.click();
  await expect(page.locator('.readonly-hint')).toHaveCount(0);
  await expect.poll(() => takeoverCalls).toBe(1);
  await expect(page.locator('.connection-notice')).toHaveCount(0);
  await page.getByRole('button', { name: '信息', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '重试连接', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '接管控制权', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('任务内容')).toHaveValue('统一导航保留草稿');
  const beforeHeight = (await page.locator('.conversation').boundingBox())!
    .height;
  hostOnline = false;
  await page
    .locator('.workspace-toolbar')
    .getByRole('button', { name: '刷新状态', exact: true })
    .click();
  await expect(page.locator('.connection-notice')).toContainText('服务器离线');
  assert.equal(
    (await page.locator('.conversation').boundingBox())!.height,
    beforeHeight,
    'floating connection status does not resize conversation',
  );
  await page.screenshot({
    path: join(artifacts, 'connection-floating.png'),
    animations: 'disabled',
  });
  hostOnline = true;
  await page
    .locator('.workspace-toolbar')
    .getByRole('button', { name: '刷新状态', exact: true })
    .click();
  await expect(page.locator('.connection-notice')).toHaveCount(0);
  observer.takeover();
  await expect(page.locator('.readonly-hint')).toContainText('其他页面');
  const observerAttaches = calls();
  const observerTakeovers = takeoverCalls;
  observer.append('另一设备继续对话后原页面补回的新消息');
  await page.evaluate(() =>
    document.dispatchEvent(new Event('visibilitychange')),
  );
  await expect(
    page.getByText('另一设备继续对话后原页面补回的新消息', { exact: true }),
  ).toBeVisible();
  assert.equal(
    calls(),
    observerAttaches,
    'observer read recovery never reattaches',
  );
  assert.equal(
    takeoverCalls,
    observerTakeovers,
    'observer read recovery never takes control',
  );
  observer.resume();
  page.once('dialog', (dialog) => dialog.accept());
  await continuation.click();
  await expect(page.locator('.readonly-hint')).toHaveCount(0);
  await expect(page.getByLabel('任务内容')).toBeEnabled();
  await expect(
    page.getByRole('button', { name: '发送', exact: true }),
  ).toBeEnabled();
  const beforeRetry = calls();
  transientFailures = 1;
  await emitState('disconnect');
  await expect(page.locator('.connection-notice')).toContainText('连接中');
  await expect(
    page
      .locator('.connection-notice')
      .getByRole('button', { name: '重试连接', exact: true }),
  ).toBeVisible();
  await expect.poll(calls, { timeout: 15000 }).toBeGreaterThan(beforeRetry);
  await expect(page.locator('.connection-notice')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '发送', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByRole('alert').filter({ hasText: 'HOST_OFFLINE' }),
  ).toHaveCount(0);
  for (const state of ['closed', 'failed', 'starting', 'closing']) {
    emitState(state);
    const hint = page.locator('.readonly-hint');
    await expect(hint).toBeVisible();
    await expect(
      hint.getByRole('button', { name: '继续对话', exact: true }),
    ).toHaveCount(['closed', 'failed'].includes(state) ? 1 : 0);
    await expect(hint).not.toContainText('显式恢复');
    if (state === 'closed') {
      await expect(hint).toContainText('历史记录');
      await page.screenshot({
        path: join(artifacts, 'continue-history.png'),
        animations: 'disabled',
      });
    }
    if (state === 'starting') await expect(hint).toContainText('启动中');
    if (state === 'closing') await expect(hint).toContainText('正在结束');
  }
  emitState('ready');
  await chooseHost.click();
  await page.getByRole('button', { name: /另一台服务器.*离线/ }).click();
  await expect(chooseProject).toBeEnabled();
  await expect(chooseSession).toBeDisabled();
  await expect(page.getByLabel('任务内容')).not.toBeVisible();
  await page.getByRole('button', { name: '新建项目', exact: true }).click();
  await expect(
    page.getByLabel('远程目录绝对路径', { exact: true }),
  ).toHaveValue('/');
  await chooseHost.click();
  await page.getByRole('button', { name: /示例服务器.*在线/ }).click();
  await expect(chooseSession).toBeDisabled();
  await page
    .locator('#navigation-projects .navigation-option')
    .filter({ hasText: '示例项目' })
    .click();
  await page
    .locator('#navigation-sessions')
    .getByRole('button', { name: /进行中的对话/ })
    .click();
  await expect(page.getByLabel('任务内容')).toHaveValue('统一导航保留草稿');
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 320, height: 568 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(
      page.getByRole('button', { name: '打开会话导航', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '打开会话导航', exact: true })
      .click();
    await expect(
      page.getByRole('dialog', { name: '会话导航', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: '打开会话导航', exact: true }),
    ).toBeFocused();
    await page
      .getByRole('button', { name: '打开会话导航', exact: true })
      .click();
    await page.locator('.session.active').click();
    await expect(
      page.getByRole('dialog', { name: '会话导航', exact: true }),
    ).not.toBeVisible();
    await page.getByRole('button', { name: '信息', exact: true }).click();
    await insideViewport(
      page.getByRole('button', { name: '关闭信息', exact: true }),
    );
    await insideViewport(
      page
        .getByRole('dialog', { name: '会话详情', exact: true })
        .getByRole('button', { name: '结束会话', exact: true }),
    );
    await page.keyboard.press('Escape');
    await noOverflow();
    await page.screenshot({
      path: join(artifacts, `navigation-mobile-${viewport.width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '文件浏览器', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '浏览', exact: true }).click();
    await page.getByRole('button', { name: /report.md/ }).click();
    await expect(
      page.getByRole('region', { name: '文件预览', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: '文件浏览器', exact: true }),
    ).not.toBeVisible();
    await insideViewport(
      page.getByRole('button', { name: '返回文件列表', exact: true }),
    );
    await page
      .getByRole('button', { name: '返回文件列表', exact: true })
      .click();
    await expect(
      page.getByRole('region', { name: '文件浏览器', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: '文件预览', exact: true }),
    ).not.toBeVisible();
    await page.getByRole('button', { name: /report.md/ }).click();
    await page.getByRole('button', { name: '文件浏览器', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '文件浏览器', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: '文件预览', exact: true }),
    ).not.toBeVisible();
    await page.getByRole('button', { name: /report.md/ }).click();
    await page.getByRole('button', { name: '关闭预览', exact: true }).click();
    await noOverflow();
    await page
      .getByRole('button', { name: '关闭文件浏览器', exact: true })
      .click();
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(
    page.getByRole('button', { name: '设置', exact: true }),
  ).toBeVisible();
  await openSettings();
  await page
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .click();
  await page.getByLabel('所有者密钥').fill('synthetic-owner-secret');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '待授权请求', exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('tablist', { name: '管理功能' })).toBeVisible();
  await page.getByRole('tab', { name: 'API Key 管理', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'API Key 管理', exact: true }),
  ).toBeVisible();
  await noOverflow();
  await page.screenshot({
    path: join(artifacts, 'navigation-admin.png'),
    fullPage: true,
    animations: 'disabled',
  });
  assert.deepEqual(failures, []);
  await context.close();
  fixtureRoutes.unroute('**/api/v1/sessions/sample~session/attach');
  fixtureRoutes.unroute('**/api/v1/sessions/sample~session/takeover');
  fixtureRoutes.unroute('**/api/v1/hosts/sample/files');
  fixtureRoutes.unroute('**/api/v1/hosts/sample/project-management');
  console.log(
    'PASS: unified navigation, project/session switching, mobile drawer, toolbar, merged file transfers, exclusive right panels, retained Terminal/draft, themes, density and administration; no browser errors',
  );
}

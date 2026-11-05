import assert from 'node:assert/strict';
import { fixtureRoutes } from './encrypted-fixture.ts';
import { join } from 'node:path';
import { expect, type Browser } from '@playwright/test';

export async function navigationUI(
  browser: Browser,
  origin: string,
  artifacts: string,
  calls: () => number,
) {
  const bytes = Buffer.from(
    '# Unified files\n\n| Name | Result |\n| --- | --- |\n| preview | ready |\n\n```ts\nconst value = 42;\n```\n',
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
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
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
  await page.getByLabel('主机', { exact: true }).selectOption('sample');
  await page.getByRole('button', { name: /进行中的对话/ }).click();
  await expect(page.getByLabel('任务内容')).toBeVisible();
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
  await expect(page.getByLabel('主机', { exact: true })).not.toBeVisible();
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
  await expect(preview.locator('table')).toContainText('ready');
  await expect(preview.locator('code')).toContainText('const value = 42');
  await noOverflow();
  await page.screenshot({
    path: join(artifacts, 'navigation-files.png'),
    fullPage: true,
    animations: 'disabled',
  });
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
    page.getByRole('complementary', { name: '会话详情', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.unified-output')).not.toBeVisible();
  await page.getByRole('button', { name: '关闭信息', exact: true }).click();
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
  await page.getByLabel('项目', { exact: true }).selectOption('other-project');
  await page.getByRole('button', { name: /第二项目对话/ }).click();
  await expect(page.getByLabel('任务内容')).toHaveValue('');
  await page.getByLabel('项目', { exact: true }).selectOption('project');
  await page.getByRole('button', { name: /进行中的对话/ }).click();
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
  fixtureRoutes.unroute('**/api/v1/hosts/sample/files');
  console.log(
    'PASS: unified navigation, project/session switching, mobile drawer, toolbar, merged file transfers, exclusive right panels, retained Terminal/draft, themes, density and administration; no browser errors',
  );
}

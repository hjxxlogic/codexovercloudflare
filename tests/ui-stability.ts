// Synthetic UI stress checks: no production credentials or model tasks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { WebSocketServer, WebSocket } from 'ws';

const artifacts = process.env.COC_ARTIFACT_DIR || '.local/ui-stability';
mkdirSync(artifacts, { recursive: true });
const session = {
  id: 'sample~session',
  projectId: 'project',
  mode: 'web',
  state: 'ready',
  running: false,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  threadId: 'thread',
};
const otherSession = {
  ...session,
  id: 'sample~other',
  projectId: 'other-project',
  title: '第二项目对话',
  threadId: 'other-thread',
};
let availableProjects = [
  { id: 'project', name: '示例项目', path: '/workspace/example' },
  { id: 'other-project', name: '第二项目', path: '/workspace/other' },
];
let identity = 'synthetic-ui-identity';
let online = true,
  logged = true,
  admin = false,
  attachFailures = 0,
  attachCalls = 0;
let approvals: unknown[] = [];
const submitted = new Set<string>();
let contentCalls = 0;
let pagedHistory:
  | { seq: number; type: string; data: { text: string }; time: number }[]
  | undefined;
let olderPageCalls = 0;
let failOlderPageOnce = false;
const events = [
  { seq: 1, type: 'user', data: { text: '示例任务' }, time: 1 },
  ...[2, 3, 4].map((seq) => ({
    seq,
    type: 'item/completed',
    data: {
      item: {
        id: `tool-${seq}`,
        type: 'commandExecution',
        command: `echo example-${seq}`,
        exitCode: 0,
      },
    },
    time: seq,
  })),
  {
    seq: 5,
    type: 'item/agentMessage/delta',
    data: {
      delta:
        '任务已完成。\n\n[下载报告](/workspace/example/docs/report.bin:12) · `docs/report.bin` · docs/missing.txt · [项目外文件](/etc/passwd) · [外部网站](https://example.com/)',
    },
    time: 5,
  },
  {
    seq: 6,
    revision: 6,
    contentSeq: 6,
    type: 'item/agentMessage/delta',
    data: {},
    time: 6,
  },
];
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://localhost');
  if (url.pathname.startsWith('/api/v1')) {
    const path = url.pathname.slice(7);
    res.setHeader('Content-Type', 'application/json');
    let body: unknown = {};
    if ((path === '/auth/me' && !admin) || (!logged && path === '/hosts')) {
      res.statusCode = 401;
      body = { error: { code: 'UNAUTHORIZED', message: 'Login required' } };
    } else if (path === '/auth/login') admin = true;
    else if (path === '/auth/logout') admin = false;
    else if (path === '/admin/devices') body = { pending: [], credentials: [] };
    else if (path === '/admin/api-keys' || path === '/admin/hosts') body = [];
    else if (path === '/hosts')
      body = [{ id: 'sample', name: '示例服务器', online }];
    else if (path === '/client/identity') body = { identity };
    else if (path === '/hosts/sample/projects') body = availableProjects;
    else if (path === '/sessions')
      body =
        url.searchParams.get('paged') === 'true'
          ? { data: [session, otherSession], nextCursor: null }
          : [session, otherSession];
    else if (path === '/hosts/sample/threads')
      body = { data: [], nextCursor: null };
    else if (path.startsWith('/hosts/sample/requests/'))
      body = { state: 'submitted' };
    else if (/^\/sessions\/sample~[\w-]+\/attach$/.test(path)) {
      attachCalls++;
      if (attachFailures-- > 0) {
        res.statusCode = 503;
        body = {
          error: { code: 'HOST_OFFLINE', message: 'Temporarily offline' },
        };
      } else body = { ticket: 'synthetic-ticket' };
    } else if (path === '/hosts/sample/files')
      body = { entries: [], next: null, writable: true, maxSize: 20971520 };
    res.end(JSON.stringify(body));
    return;
  }
  const root = resolve('dist/web');
  const file = resolve(
    root,
    '.' + (url.pathname === '/' ? '/index.html' : url.pathname),
  );
  if (!file.startsWith(root + '/')) {
    res.statusCode = 403;
    res.end();
    return;
  }
  try {
    res.setHeader(
      'Content-Type',
      (
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
        } as Record<string, string>
      )[extname(file)] || 'application/octet-stream',
    );
    res.end(readFileSync(file));
  } catch {
    res.statusCode = 404;
    res.end();
  }
});
const sockets = new Set<WebSocket>();
const controls = new Set<WebSocket>();
const wss = new WebSocketServer({ server });
const controlSessions = new WeakMap<WebSocket, typeof session>();
const sync = (ws: WebSocket) =>
  ws.send(
    JSON.stringify({
      type: 'sync',
      session: {
        ...(controlSessions.get(ws) || session),
        running: approvals.length > 0,
      },
      approvals,
      events: [],
      more: false,
    }),
  );
wss.on('connection', (ws, request) => {
  sockets.add(ws);
  ws.on('close', () => {
    sockets.delete(ws);
    controls.delete(ws);
  });
  controlSessions.set(
    ws,
    request.url?.includes(otherSession.id) ? otherSession : session,
  );
  const history = request.url?.includes('/history/');
  if (history) ws.send(JSON.stringify({ type: 'history-ready' }));
  else controls.add(ws);
  ws.on('message', (raw) => {
    const data = JSON.parse(String(raw));
    if (data.type === 'receipt') return;
    if (history && data.operation === 'content') {
      contentCalls++;
      const text =
        data.offset === 0
          ? '第一段'
          : data.offset === 3
            ? '第二段'
            : '完整正文'.repeat(1024);
      const nextOffset = data.offset + text.length;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: 'history',
              requestId: data.requestId,
              seq: 6,
              revision: 6,
              offset: data.offset,
              text,
              nextOffset,
              more: nextOffset < 6 + 32 * 4096,
            }),
          );
      }, 200);
    } else if (history && pagedHistory) {
      if (data.before) olderPageCalls++;
      const page =
        data.after === undefined
          ? pagedHistory
              .filter((event) => !data.before || event.seq < data.before)
              .slice(-150)
          : [];
      const fail = !!data.before && failOlderPageOnce;
      if (fail) failOlderPageOnce = false;
      const response = JSON.stringify(
        fail
          ? {
              type: 'error',
              requestId: data.requestId,
              error: {
                code: 'HISTORY_UNAVAILABLE',
                message: '模拟历史读取失败',
              },
            }
          : {
              type: 'history',
              requestId: data.requestId,
              events: page,
              more: (page[0]?.seq ?? 1) > 1,
              cursor: page[0]?.seq ?? 600,
              snapshotSeq: 600,
              direction: data.after === undefined ? 'before' : 'after',
            },
      );
      setTimeout(
        () => {
          if (ws.readyState === WebSocket.OPEN) ws.send(response);
        },
        data.before ? 300 : 0,
      );
    } else if (history)
      ws.send(
        JSON.stringify({
          type: 'history',
          requestId: data.requestId,
          events,
          more: false,
          cursor: 1,
          snapshotSeq: 5,
          direction: data.after === undefined ? 'before' : 'after',
        }),
      );
    else if (data.type === 'auth')
      ws.send(JSON.stringify({ type: 'attached', epoch: 1 }));
    else if (data.action === 'sync') sync(ws);
    else if (data.action === 'prompt') submitted.add(data.requestId);
  });
});
await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const browser = await chromium.launch({ headless: true });
async function openMenu(page: Page) {
  if (await page.getByRole('dialog').isVisible())
    await page.getByRole('button', { name: '关闭面板' }).click();
  await page.getByRole('button', { name: '功能菜单' }).click();
}
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(origin);
  await openMenu(page);
  await page.getByRole('button', { name: /^会话记录/ }).click();
  const settings = page.getByRole('region', { name: '连接设置' });
  await expect(settings).toBeVisible();
  assert(
    (await settings.boundingBox())!.y <
      (await page.getByRole('heading', { name: '会话列表' }).boundingBox())!.y,
    'connection settings precede the session list',
  );
  await page.screenshot({
    path: join(artifacts, 'cw-session-connections.png'),
  });
  await page.getByLabel('主机', { exact: true }).selectOption('sample');
  await openMenu(page);
  await page.getByRole('button', { name: /^会话记录/ }).click();
  attachFailures = 2;
  await page.getByRole('button', { name: /进行中的对话/ }).click();
  await page
    .locator('.workspace-context')
    .getByText('已连接', { exact: true })
    .waitFor({ timeout: 20000 });
  assert(attachCalls >= 3, 'temporary ticket failures retry');
  const group = page.locator('.tool-group');
  assert.equal(await group.count(), 1);
  assert.equal(await group.getAttribute('open'), null);
  assert.match(await group.locator(':scope > summary').innerText(), /3 项/);
  const downloadBytes = Buffer.alloc(65539, 255);
  const fileReads: {
    projectId: string;
    path: string;
    offset: number;
    version?: string;
  }[] = [];
  await page.route('**/api/v1/hosts/sample/files', async (route) => {
    const data = route.request().postDataJSON();
    if (data.operation !== 'read') return route.continue();
    fileReads.push(data);
    if (data.path === 'docs/missing.txt')
      return route.fulfill({
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: 'File not found' } },
      });
    const chunk = downloadBytes.subarray(data.offset, data.offset + 65536);
    await route.fulfill({
      json: {
        data: chunk.toString('base64'),
        size: downloadBytes.length,
        offset: data.offset + chunk.length,
        version: 'report-v1',
      },
    });
  });
  await page
    .getByRole('link', { name: '下载 docs/missing.txt', exact: true })
    .click();
  await expect(page.getByText(/下载失败：NOT_FOUND/)).toBeVisible();
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const saved = page.waitForEvent('download');
    await page
      .getByRole('link', { name: '下载 docs/report.bin', exact: true })
      .first()
      .click();
    const download = await saved;
    assert.equal(download.suggestedFilename(), 'report.bin');
    assert.deepEqual(readFileSync((await download.path())!), downloadBytes);
    await expect(
      page
        .getByRole('link', { name: '下载 docs/report.bin', exact: true })
        .first(),
    ).toHaveAttribute('aria-disabled', 'false');
    await page.screenshot({
      path: join(artifacts, `chat-download-${viewport.width}.png`),
    });
  }
  assert(fileReads.every((read) => read.projectId === 'project'));
  assert.equal(
    fileReads.filter(
      (read) => read.offset === 65536 && read.version === 'report-v1',
    ).length,
    2,
  );
  await expect(page.locator('a[href="/etc/passwd"]')).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: '外部网站', exact: true }),
  ).toHaveAttribute('href', 'https://example.com/');
  await page.getByRole('button', { name: '展开内容' }).click();
  await page.getByText('第一段', { exact: true }).waitFor();
  await page.getByRole('button', { name: '展开更多' }).click();
  await page.getByText('第一段第二段', { exact: true }).waitFor();
  assert.equal(contentCalls, 2, 'content chunks accumulate once per offset');
  for (let i = 0; i < 32; i++) {
    await page.getByRole('button', { name: '展开更多' }).click();
    await expect(
      page.getByRole('button', { name: i === 31 ? '已读完' : '展开更多' }),
    ).toBeVisible();
  }
  const fullBody = await page
    .locator('[data-event-seq="6"] .markdown')
    .innerText();
  assert.equal(
    fullBody,
    '第一段第二段' + '完整正文'.repeat(32 * 1024),
    'expanded content beyond 128 Ki characters retains its entire prefix',
  );
  assert.equal(contentCalls, 34);
  await page.getByLabel('任务内容').fill('切换后仍应保留的草稿');
  const callsBeforeModeSwitch = attachCalls;
  await openMenu(page);
  const menu = page.getByRole('navigation', { name: '功能菜单' });
  const cwFeatures = [
    /^会话记录/,
    /^新建对话/,
    /^工作区文件/,
    /^会话详情/,
    /^CW 对话/,
  ];
  const adminFeatures = [/^设备授权/, /^API Key/, /^退出管理/];
  for (const name of cwFeatures)
    await expect(menu.getByRole('button', { name })).toBeVisible();
  for (const name of adminFeatures)
    await expect(menu.getByRole('button', { name })).toHaveCount(0);
  await menu
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .press('Enter');
  await expect(
    menu.getByRole('button', { name: '切换到CW模式', exact: true }),
  ).toBeFocused();
  for (const name of cwFeatures)
    await expect(menu.getByRole('button', { name })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await expect(page.getByLabel('服务器标识')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '设备授权管理' })).toHaveCount(
    0,
  );
  await page.keyboard.press('Escape');
  await page.getByLabel('所有者密钥').fill('synthetic-owner-secret');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '设备授权管理' }),
  ).toBeVisible();
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    await openMenu(page);
    for (const name of adminFeatures)
      await expect(menu.getByRole('button', { name })).toBeVisible();
    for (const name of cwFeatures)
      await expect(menu.getByRole('button', { name })).toHaveCount(0);
    const switchButton = menu.getByRole('button', {
      name: '切换到CW模式',
      exact: true,
    });
    assert(
      (await switchButton.boundingBox())!.y >
        (await menu.locator('.menu-items').boundingBox())!.y,
    );
    await page.screenshot({
      path: join(artifacts, `menu-admin-${viewport.width}.png`),
    });
    await switchButton.click();
    for (const name of cwFeatures)
      await expect(menu.getByRole('button', { name })).toBeVisible();
    for (const name of adminFeatures)
      await expect(menu.getByRole('button', { name })).toHaveCount(0);
    const bounds = (await menu
      .getByRole('button', { name: '切换到管理员模式', exact: true })
      .boundingBox())!;
    assert(
      bounds.y + bounds.height <= viewport.height,
      'mode switch stays visible in short viewport',
    );
    await page.screenshot({
      path: join(artifacts, `menu-cw-${viewport.width}.png`),
    });
    await menu
      .getByRole('button', { name: '切换到管理员模式', exact: true })
      .click();
    await page.keyboard.press('Escape');
  }
  await openMenu(page);
  await menu.getByRole('button', { name: /^API Key/ }).click();
  await expect(
    page.getByRole('heading', { name: 'API Key 管理' }),
  ).toBeVisible();
  await openMenu(page);
  await menu.getByRole('button', { name: /^退出管理/ }).click();
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'API Key 管理' })).toHaveCount(
    0,
  );
  await openMenu(page);
  await menu.getByRole('button', { name: '切换到CW模式', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('任务内容')).toHaveValue('切换后仍应保留的草稿');
  assert.equal(
    attachCalls,
    callsBeforeModeSwitch,
    'mode switches and admin logout preserve the CW connection',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByText('任务已完成。', { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      (document.querySelector('textarea') as HTMLTextAreaElement)?.value ===
      '切换后仍应保留的草稿',
  );
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.getByText('正在提交任务', { exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector('textarea')?.value === '',
  );
  await page.reload();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await page.getByText('任务已完成。', { exact: true }).waitFor();
  await page.getByText('任务提交结果待确认', { exact: true }).waitFor();
  assert.equal(
    submitted.size,
    1,
    'lost acknowledgement never automatically resubmits prompt',
  );
  for (const height of [844, 480]) {
    await page.setViewportSize({ width: 390, height });
    for (const count of [0, 1, 3, 10]) {
      approvals = Array.from({ length: count }, (_, index) => ({
        approvalId: `approval-${index}`,
        method: 'item/commandExecution/requestApproval',
        params: {
          command: 'echo ' + '长命令 '.repeat(2000),
          reason: '布局测试',
          cwd: '/workspace/example',
        },
      }));
      for (const ws of controls) sync(ws);
      if (count) await page.getByText(`等待你的确认 · 1 / ${count}`).waitFor();
      else await page.locator('.approval-queue').waitFor({ state: 'hidden' });
      const bounds = await page.evaluate(() => {
        const composer = document
          .querySelector('.composer')!
          .getBoundingClientRect();
        const actions = document
          .querySelector('.approval-actions')
          ?.getBoundingClientRect();
        return {
          bottom: composer.bottom,
          actionsBottom: actions?.bottom,
          height: innerHeight,
          width: innerWidth,
          scrollWidth: document.documentElement.scrollWidth,
          scrollHeight: document.documentElement.scrollHeight,
        };
      });
      assert(bounds.bottom <= height, JSON.stringify(bounds));
      assert(!count || bounds.actionsBottom! <= height, JSON.stringify(bounds));
      assert(
        bounds.scrollWidth <= bounds.width &&
          bounds.scrollHeight <= bounds.height,
        JSON.stringify(bounds),
      );
      if (count === 3)
        await page.screenshot({
          path: join(artifacts, `approvals-${height}.png`),
        });
    }
  }
  approvals = [];
  for (const ws of controls) sync(ws);
  approvals = [
    {
      approvalId: 'files',
      method: 'item/fileChange/requestApproval',
      params: {
        itemId: 'file-change',
        grantRoot: '/workspace/example',
        reason: '文件变更测试',
      },
    },
  ];
  for (const ws of controls) {
    ws.send(
      JSON.stringify({
        type: 'event',
        event: {
          seq: 7,
          type: 'item/started',
          time: 7,
          data: {
            item: {
              id: 'file-change',
              type: 'fileChange',
              changes: [
                {
                  path: '/workspace/example/sample.txt',
                  kind: { type: 'update' },
                  diff: '-old\n+new',
                },
              ],
            },
          },
        },
      }),
    );
    sync(ws);
  }
  await page.getByText('请求修改文件', { exact: true }).waitFor();
  await page
    .getByText('/workspace/example/sample.txt · 修改', { exact: true })
    .click();
  assert.equal(
    (await page.locator('.approval-queue .diff-add').innerText()).trimEnd(),
    '+new',
  );
  approvals = [];
  for (const ws of controls) sync(ws);
  await page.setViewportSize({ width: 390, height: 844 });
  await openMenu(page);
  await page.waitForTimeout(4500);
  assert(await page.getByRole('navigation').isVisible());
  await page.getByRole('button', { name: /^工作区文件/ }).click();
  const dialog = page.getByRole('dialog');
  const box = (await dialog.boundingBox())!;
  await page.mouse.click(box.x + 4, box.y + box.height / 2);
  assert(await dialog.isVisible(), 'dialog padding stays open');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '功能菜单' })).toBeFocused();
  online = false;
  await page.reload();
  await page.getByText('任务已完成。', { exact: true }).waitFor();
  assert(
    await page.getByRole('button', { name: '发送', exact: true }).isDisabled(),
  );
  await page
    .locator('.workspace-context')
    .getByText('服务器离线 · 只读缓存')
    .waitFor();
  online = true;
  for (const size of [0, 400]) {
    pagedHistory = Array.from({ length: 600 }, (_, index) => ({
      seq: index + 1,
      type: 'user',
      data: { text: `历史消息 ${index + 1} ${'x'.repeat(size)}` },
      time: index + 1,
    }));
    const historyPage = await browser.newPage();
    historyPage.on('pageerror', (error) => failures.push(error.message));
    await historyPage.goto(origin);
    await openMenu(historyPage);
    await historyPage.getByRole('button', { name: /^会话记录/ }).click();
    await historyPage
      .getByLabel('主机', { exact: true })
      .selectOption('sample');
    await openMenu(historyPage);
    await historyPage.getByRole('button', { name: /^会话记录/ }).click();
    await historyPage.getByRole('button', { name: /进行中的对话/ }).click();
    const messages = historyPage.locator('[data-event-seq]');
    await expect(messages).toHaveCount(150);
    const loadOlder = historyPage.getByRole('button', { name: '加载更早内容' });
    if (size) {
      failOlderPageOnce = true;
      await loadOlder.evaluate((button) =>
        (button as HTMLButtonElement).click(),
      );
      await historyPage
        .getByRole('alert')
        .filter({ hasText: '模拟历史读取失败' })
        .waitFor({ timeout: 5000 });
      await expect(loadOlder).toBeEnabled();
      await expect(messages).toHaveCount(150);
      await historyPage
        .locator('.error')
        .getByRole('button', { name: '关闭', exact: true })
        .click();
    }
    const callsBefore = olderPageCalls;
    for (const count of [300, 450, 600]) {
      if (size) {
        await historyPage.locator('.messages').evaluate((el) => {
          el.scrollTop = 240;
        });
        await expect
          .poll(() =>
            historyPage.locator('.messages').evaluate((el) => el.scrollTop),
          )
          .toBe(240);
      }
      const anchor = messages.first();
      const seq = await anchor.getAttribute('data-event-seq');
      const top = size
        ? await historyPage.locator('.messages').evaluate((el) => {
            el.scrollTop = 80;
            const top = el
              .querySelector('[data-event-seq]')!
              .getBoundingClientRect().top;
            for (let index = 0; index < 5; index++)
              el.dispatchEvent(new Event('scroll'));
            return top;
          })
        : (await anchor.boundingBox())!.y;
      if (!size)
        await loadOlder.evaluate((button) =>
          (button as HTMLButtonElement).click(),
        );
      await expect(messages).toHaveCount(count);
      await expect
        .poll(
          async () => {
            const box = await historyPage
              .locator(`[data-event-seq="${seq}"]`)
              .boundingBox();
            return Math.abs(box!.y - top);
          },
          { message: `reading anchor for size ${size}, count ${count}` },
        )
        .toBeLessThan(2);
    }
    assert.equal(
      olderPageCalls - callsBefore,
      3,
      'scroll bursts do not duplicate page requests',
    );
    assert.deepEqual(
      await messages.evaluateAll((nodes) =>
        nodes.map((node) => Number((node as HTMLElement).dataset.eventSeq)),
      ),
      pagedHistory.map((event) => event.seq),
      'all fetched history remains visible in sequence without duplicates',
    );
    await expect(loadOlder).toHaveCount(0);
    const callsAtStart = olderPageCalls;
    await historyPage.locator('.messages').evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event('scroll'));
    });
    assert.equal(
      olderPageCalls,
      callsAtStart,
      'no automatic requests after history is exhausted',
    );
    const returnLatest = historyPage.getByRole('button', {
      name: '返回最新内容',
    });
    await returnLatest.click();
    await expect(loadOlder).toBeEnabled();
    assert(
      (await messages.count()) <= 400,
      'return latest restores a bounded window',
    );
    await expect(messages.last()).toHaveAttribute('data-event-seq', '600');
    const calls = olderPageCalls;
    for (let index = 0; index < 3; index++) {
      await expect(loadOlder).toBeEnabled();
      await loadOlder.evaluate((button) =>
        (button as HTMLButtonElement).click(),
      );
    }
    await expect(loadOlder).toHaveCount(0);
    await expect(messages).toHaveCount(600);
    assert.equal(
      olderPageCalls,
      calls,
      'previously loaded pages use IndexedDB',
    );
    if (size)
      await historyPage.screenshot({
        path: join(artifacts, 'cw-loaded-history.png'),
      });
    await historyPage.close();
  }
  pagedHistory = undefined;
  const restoredContext = await browser.newContext();
  const restoredPage = await restoredContext.newPage();
  await restoredPage.goto(origin);
  await openMenu(restoredPage);
  await restoredPage.getByRole('button', { name: /^会话记录/ }).click();
  await restoredPage.getByLabel('主机', { exact: true }).selectOption('sample');
  await expect(restoredPage.getByLabel('项目', { exact: true })).toHaveValue(
    'project',
  );
  await restoredPage
    .getByLabel('项目', { exact: true })
    .selectOption('other-project');
  await restoredPage.getByRole('button', { name: /第二项目对话/ }).click();
  await restoredPage.getByText('任务已完成。', { exact: true }).waitFor();
  await restoredPage.getByLabel('任务内容').fill('第二项目的独立草稿');
  await restoredPage.waitForTimeout(200);
  await restoredPage.reload();
  await expect(restoredPage.getByLabel('任务内容')).toHaveValue(
    '第二项目的独立草稿',
  );
  await expect(restoredPage.locator('.workspace-context')).toContainText(
    '第二项目',
  );
  await expect(restoredPage.getByRole('dialog')).not.toBeVisible();
  await restoredPage.screenshot({
    path: join(artifacts, 'cw-restored-session.png'),
  });

  // The navigation record also works when its cached directory is absent.
  await restoredPage.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('coc-history', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('pages', 'readwrite');
          const cursor = tx.objectStore('pages').openCursor();
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            if (Array.isArray(row.key) && row.key[1] === 'catalog')
              row.delete();
            row.continue();
          };
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => {
            db.close();
            reject(tx.error);
          };
        };
      }),
  );
  await restoredPage.reload();
  await expect(restoredPage.getByLabel('任务内容')).toHaveValue(
    '第二项目的独立草稿',
  );
  await expect(restoredPage.locator('.workspace-context')).toContainText(
    '第二项目',
  );

  // Removing a configured project invalidates its remembered conversation.
  availableProjects = availableProjects.slice(0, 1);
  await restoredPage.reload();
  await openMenu(restoredPage);
  await restoredPage.getByRole('button', { name: /^会话记录/ }).click();
  await expect(restoredPage.getByLabel('项目', { exact: true })).toHaveValue(
    'project',
  );
  await restoredPage.getByRole('button', { name: /进行中的对话/ }).click();
  await restoredPage.getByLabel('任务内容').fill('旧凭证下的草稿');
  await restoredPage.waitForTimeout(200);
  identity = 'replacement-credential-identity';
  await restoredPage.reload();
  await openMenu(restoredPage);
  await restoredPage.getByRole('button', { name: /^会话记录/ }).click();
  await expect(restoredPage.getByLabel('主机', { exact: true })).toHaveValue(
    'sample',
  );
  await expect(restoredPage.getByLabel('项目', { exact: true })).toHaveValue(
    'project',
  );
  await restoredPage.keyboard.press('Escape');
  await expect(restoredPage.locator('.message')).toHaveCount(0);
  await expect(restoredPage.getByLabel('任务内容')).toHaveCount(0);
  // An untrusted host hint never bypasses the authorized host list.
  await restoredPage.evaluate(() =>
    localStorage.setItem('coc:last-host', 'unauthorized-host'),
  );
  await restoredPage.reload();
  await openMenu(restoredPage);
  await restoredPage.getByRole('button', { name: /^会话记录/ }).click();
  await expect(restoredPage.getByLabel('主机', { exact: true })).toHaveValue(
    '',
  );
  assert.equal(
    await restoredPage.evaluate(() => localStorage.getItem('coc:last-host')),
    null,
  );
  await restoredContext.close();
  identity = 'synthetic-ui-identity';
  logged = false;

  await page.goto(origin);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('heading', { name: '连接远程服务器' }).waitFor();
  assert((await page.locator('.login-card').boundingBox())!.width <= 520);
  await expect(page.getByLabel('服务器标识')).toHaveCount(0);
  await expect(page.getByLabel('给管理员留言')).toHaveAttribute(
    'maxlength',
    '1000',
  );
  await page
    .getByLabel('给管理员留言')
    .fill('请授权开发服务器，用于项目维护。');
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(page.getByLabel('给管理员留言')).toBeVisible();
    await expect(
      page.getByRole('button', { name: '申请登录', exact: true }),
    ).toBeVisible();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      'login form has no horizontal overflow',
    );
    await page.screenshot({
      path: join(artifacts, `cw-request-${viewport.width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMenu(page);
  await expect(menu.getByRole('button', { name: /^登录与授权/ })).toBeVisible();
  await expect(menu.getByRole('button', { name: /^设备授权/ })).toHaveCount(0);
  await menu
    .getByRole('button', { name: '切换到管理员模式', exact: true })
    .click();
  await expect(menu.getByRole('button', { name: /^登录与授权/ })).toHaveCount(
    0,
  );
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await page.goto('about:blank');
  await page.goto(origin + '/#authorize=synthetic-request');
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await openMenu(page);
  await expect(menu.getByRole('button', { name: /^设备授权/ })).toBeVisible();
  await expect(menu.getByRole('button', { name: /^CW 对话/ })).toHaveCount(0);
  assert.deepEqual(failures, []);
  console.log(
    'PASS: automatic host/project/session/draft restoration after refresh, offline restoration, removed-project fallback, credential isolation, desktop/mobile chat file downloads with binary integrity, missing-file errors and external-path isolation, full expanded content beyond 128 Ki characters, ticket retry, collapsed consecutive tools, persistent drafts, 0/1/3/10 approvals at mobile/short viewport, CW/admin mode isolation, mode switch layout/focus/login/logout/deep links without reconnecting CW, dialog padding/focus, offline catalog, session connection settings, automatic and manual paged history with cached reload and first visit',
  );
} finally {
  await browser.close();
  for (const ws of sockets) ws.terminate();
  await new Promise<void>((done) => wss.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
}

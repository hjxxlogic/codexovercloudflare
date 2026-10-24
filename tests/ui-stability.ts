// Synthetic UI stress checks: no production credentials or model tasks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { chromium, expect } from '@playwright/test';
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
  threadId: 'thread',
};
let online = true,
  logged = true,
  attachFailures = 0,
  attachCalls = 0;
let approvals: unknown[] = [];
const submitted = new Set<string>();
let contentCalls = 0;
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
    data: { delta: '任务已完成。' },
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
    if (path === '/auth/me' || (!logged && path === '/hosts')) {
      res.statusCode = 401;
      body = { error: { code: 'UNAUTHORIZED', message: 'Login required' } };
    } else if (path === '/hosts')
      body = [{ id: 'sample', name: '示例服务器', online }];
    else if (path === '/client/identity')
      body = { identity: 'synthetic-ui-identity' };
    else if (path === '/hosts/sample/projects')
      body = [{ id: 'project', name: '示例项目', path: '/workspace/example' }];
    else if (path === '/sessions')
      body =
        url.searchParams.get('paged') === 'true'
          ? { data: [session], nextCursor: null }
          : [session];
    else if (path === '/hosts/sample/threads')
      body = { data: [], nextCursor: null };
    else if (path.startsWith('/hosts/sample/requests/'))
      body = { state: 'submitted' };
    else if (path === '/sessions/sample~session/attach') {
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
const sync = (ws: WebSocket) =>
  ws.send(
    JSON.stringify({
      type: 'sync',
      session: { ...session, running: approvals.length > 0 },
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
  const history = request.url?.includes('/history/');
  if (history) ws.send(JSON.stringify({ type: 'history-ready' }));
  else controls.add(ws);
  ws.on('message', (raw) => {
    const data = JSON.parse(String(raw));
    if (data.type === 'receipt') return;
    if (history && data.operation === 'content') {
      contentCalls++;
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(
            JSON.stringify({
              type: 'history',
              requestId: data.requestId,
              seq: 6,
              revision: 6,
              offset: data.offset,
              text: data.offset ? '第二段' : '第一段',
              nextOffset: data.offset ? 6 : 3,
              more: !data.offset,
            }),
          );
      }, 200);
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
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto(origin);
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /连接设置 主机/ }).click();
  await page.getByLabel('主机', { exact: true }).selectOption('sample');
  await page.getByRole('button', { name: '功能菜单' }).click();
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
  await page.getByRole('button', { name: '展开内容' }).click();
  await page.getByText('第一段', { exact: true }).waitFor();
  await page.getByRole('button', { name: '展开更多' }).click();
  await page.getByText('第一段第二段', { exact: true }).waitFor();
  assert.equal(contentCalls, 2, 'content chunks accumulate once per offset');
  await page.getByLabel('任务内容').fill('切换后仍应保留的草稿');
  await page.reload();
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /连接设置 主机/ }).click();
  await page.getByLabel('主机', { exact: true }).selectOption('sample');
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /^会话记录/ }).click();
  await page.getByRole('button', { name: /进行中的对话/ }).click();
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
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /连接设置 主机/ }).click();
  await page.getByLabel('主机', { exact: true }).selectOption('sample');
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /^会话记录/ }).click();
  await page.getByRole('button', { name: /进行中的对话/ }).click();
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
  await page.getByRole('button', { name: '功能菜单' }).click();
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
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /连接设置 主机/ }).click();
  assert.equal(
    await page
      .getByLabel('主机', { exact: true })
      .locator('option[value="sample"]')
      .isDisabled(),
    false,
  );
  await page.getByLabel('主机', { exact: true }).selectOption('sample');
  await page.getByRole('button', { name: '功能菜单' }).click();
  await page.getByRole('button', { name: /^会话记录/ }).click();
  await page.getByRole('button', { name: /进行中的对话/ }).click();
  await page.getByText('任务已完成。', { exact: true }).waitFor();
  assert(
    await page.getByRole('button', { name: '发送', exact: true }).isDisabled(),
  );
  await page
    .locator('.workspace-context')
    .getByText('服务器离线 · 只读缓存')
    .waitFor();
  logged = false;
  await page.goto(origin);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('heading', { name: '连接远程服务器' }).waitFor();
  assert((await page.locator('.login-card').boundingBox())!.width <= 520);
  assert.deepEqual(failures, []);
  console.log(
    'PASS: ticket retry, collapsed consecutive tools, persistent drafts, 0/1/3/10 approvals at mobile/short viewport, stable menu, dialog padding/focus, offline catalog and first visit',
  );
} finally {
  await browser.close();
  for (const ws of sockets) ws.terminate();
  await new Promise<void>((done) => wss.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
}

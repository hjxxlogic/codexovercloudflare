// Synthetic UI stress checks: no production credentials or model tasks.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, extname, join } from 'node:path';
import { chromium, expect, type Page } from '@playwright/test';
import { WebSocketServer, WebSocket } from 'ws';
import type { Event } from '../packages/protocol/src/index.ts';

const artifacts = process.env.COC_ARTIFACT_DIR || '.local/ui-stability';
mkdirSync(artifacts, { recursive: true });
const session = {
  id: 'sample~session',
  projectId: 'project',
  mode: 'web',
  state: 'ready',
  running: false,
  autoApproval: false,
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
let approvals: {
  approvalId: string;
  method: string;
  params: Record<string, unknown>;
  submitted?: boolean;
  unsupported?: boolean;
}[] = [];
const approvalAnswers: {
  approvalId: string;
  requestId: string;
  allow: boolean;
  sessionId: string;
}[] = [];
let dropApprovalAck = false;
let stallHistory = false;
let historyConnections = 0;
let toolRevision = 90,
  toolReads = 0,
  historyPages = 0;
let controlSyncCalls = 0;
const submitted = new Set<string>();
const promptCommands: { requestId: string; text: string; model?: string }[] =
  [];
let modelListFailure = false;
let contentCalls = 0;
let pagedHistory:
  | { seq: number; type: string; data: { text: string }; time: number }[]
  | undefined;
let olderPageCalls = 0;
let failOlderPageOnce = false;
let adminSamples = false;
const adminMessage =
  '申请说明：<script>alert(1)</script>\n' + '长留言'.repeat(100);
const adminHost = { id: 'sample', name: '示例服务器', disabled: false };
const adminPending = [
  {
    id: 'request-unbound',
    name: '待授权设备-' + 'long-name-'.repeat(12),
    role: 'web',
    code: 'TABLE001',
    message: adminMessage,
    expires: Date.now() + 300000,
  },
  {
    id: 'request-targeted',
    name: '指定目标的客户端',
    role: 'cli',
    code: 'TABLE002',
    requestedHostId: 'sample',
    message: '目标不可改绑',
    expires: Date.now() + 300000,
  },
];
const events: Event[] = [
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
        '任务已完成。\n\n[下载报告](/workspace/example/docs/report.bin:12) · `docs/report.bin` · docs/missing.txt · [项目外文件](/etc/passwd) · [外部网站](https://example.com/) · [文档](docs/report.md) · [文本](docs/plain.txt) · [图片](docs/pixel.png) · [声音](docs/tone.wav) · [视频](docs/clip.webm)',
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
    res.setHeader('X-CoC-Demand', '1');
    let body: unknown = {};
    if ((path === '/auth/me' && !admin) || (!logged && path === '/hosts')) {
      res.statusCode = 401;
      body = { error: { code: 'UNAUTHORIZED', message: 'Login required' } };
    } else if (path === '/auth/login') admin = true;
    else if (path === '/auth/logout') admin = false;
    else if (path === '/admin/devices')
      body = {
        pending: adminSamples ? adminPending : [],
        credentials: adminSamples
          ? [
              {
                id: 'credential-table',
                name: '已授权设备-' + '长名称'.repeat(20),
                role: 'cli',
                hostId: 'sample',
                created: 1700000000000,
                lastSeen: 1700000300000,
              },
              {
                id: 'agent-a',
                name: 'Agent A',
                role: 'agent',
                hostId: 'sample',
                created: 1700000000000,
              },
              {
                id: 'agent-b',
                name: 'Agent B',
                role: 'agent',
                hostId: 'second',
                created: 1700000000000,
                lastSeen: 1700000200000,
              },
              {
                id: 'web-a',
                name: 'user@example.test',
                email: 'user@example.test',
                role: 'web',
                hostId: 'sample',
                created: 1700000000000,
                lastSeen: 1700000100000,
              },
              {
                id: 'web-b',
                name: 'user@example.test',
                email: 'user@example.test',
                role: 'web',
                hostId: 'second',
                created: 1700000100000,
                lastSeen: 1700000200000,
              },
              {
                id: 'other-client',
                name: '另一个 CC',
                role: 'cli',
                hostId: 'second',
                created: 1700000200000,
              },
            ]
          : [],
      };
    else if (path === '/admin/api-keys')
      body = adminSamples
        ? [
            {
              id: 'key-table',
              name: '表格测试 Key',
              role: 'cli',
              hostId: 'sample',
              created: 1700000000000,
            },
          ]
        : [];
    else if (path === '/admin/hosts')
      body = adminSamples
        ? [adminHost, { id: 'second', name: '第二服务器', disabled: false }]
        : [];
    else if (path === '/hosts')
      body = [{ id: 'sample', name: '示例服务器', online }];
    else if (path === '/client/identity') body = { identity };
    else if (path === '/hosts/sample/probe')
      body = { online, confirmedAt: Date.now() };
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
const histories = new Set<WebSocket>();
const automaticAttempts = new Set<string>();
const applyAutomatic = () => {
  if (!session.autoApproval) return;
  for (const approval of approvals) {
    if (
      approval.submitted ||
      approval.unsupported ||
      ![
        'item/commandExecution/requestApproval',
        'item/fileChange/requestApproval',
        'item/permissions/requestApproval',
      ].includes(approval.method) ||
      automaticAttempts.has(approval.approvalId)
    )
      continue;
    automaticAttempts.add(approval.approvalId);
    approvalAnswers.push({
      approvalId: approval.approvalId,
      requestId: 'agent-auto-' + approval.approvalId,
      allow: true,
      sessionId: session.id,
    });
  }
};
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
  if (
    request.url === '/ws/v1/admin' ||
    request.url?.startsWith('/ws/v1/hosts/')
  ) {
    ws.send(JSON.stringify({ type: 'subscribed', revision: 0, demand: 1 }));
    ws.on('close', () => sockets.delete(ws));
    return;
  }
  ws.on('close', () => {
    sockets.delete(ws);
    controls.delete(ws);
    histories.delete(ws);
  });
  controlSessions.set(
    ws,
    request.url?.includes(otherSession.id) ? otherSession : session,
  );
  const history = request.url?.includes('/history/');
  if (history) {
    historyConnections++;
    histories.add(ws);
  }
  if (history) ws.send(JSON.stringify({ type: 'history-ready' }));
  else controls.add(ws);
  ws.on('message', (raw) => {
    const data = JSON.parse(String(raw));
    if (data.type === 'receipt') return;
    if (history && stallHistory) return;
    if (history && data.operation === 'page') historyPages++;
    if (history && data.operation === 'content') {
      if (data.seq === 90) {
        toolReads++;
        ws.send(
          JSON.stringify({
            type: 'history',
            requestId: data.requestId,
            seq: 90,
            revision: toolRevision,
            offset: 0,
            text: 'tool output ' + toolRevision,
            nextOffset: 14,
            more: false,
          }),
        );
        return;
      }
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
          cursor: Math.max(...events.map((e) => e.revision ?? e.seq)),
          snapshotSeq: Math.max(...events.map((e) => e.revision ?? e.seq)),
          direction: data.after === undefined ? 'before' : 'after',
        }),
      );
    else if (data.type === 'auth')
      ws.send(JSON.stringify({ type: 'attached', epoch: 1 }));
    else if (data.action === 'sync') {
      controlSyncCalls++;
      sync(ws);
    } else if (data.action === 'autoApproval') {
      const selected = controlSessions.get(ws)!;
      selected.autoApproval = data.enabled;
      applyAutomatic();
      if (dropApprovalAck) {
        dropApprovalAck = false;
        ws.close();
      } else {
        ws.send(
          JSON.stringify({
            type: 'ack',
            requestId: data.requestId,
            result: { autoApproval: data.enabled },
          }),
        );
        sync(ws);
      }
    } else if (data.action === 'models') {
      ws.send(
        JSON.stringify(
          modelListFailure
            ? {
                type: 'error',
                requestId: data.requestId,
                error: {
                  code: 'UNSUPPORTED_METHOD',
                  message: 'model/list unavailable',
                },
              }
            : {
                type: 'ack',
                requestId: data.requestId,
                result: {
                  data: data.cursor
                    ? [
                        {
                          model: 'test-model-alt',
                          displayName: 'Test alternative',
                          description: 'Another model',
                        },
                      ]
                    : [
                        {
                          model: 'test-model',
                          displayName: 'Test default',
                          isDefault: true,
                        },
                        {
                          model: 'hidden-model',
                          displayName: 'Hidden',
                          hidden: true,
                        },
                      ],
                  nextCursor: data.cursor ? null : 'second-page',
                },
              },
        ),
      );
    } else if (data.action === 'prompt') {
      submitted.add(data.requestId);
      promptCommands.push(data);
    } else if (data.action === 'approval') {
      approvalAnswers.push({
        approvalId: data.approvalId,
        requestId: data.requestId,
        allow: data.allow,
        sessionId: controlSessions.get(ws)!.id,
      });
      if (dropApprovalAck) {
        dropApprovalAck = false;
        ws.close();
      } else {
        ws.send(
          JSON.stringify({
            type: 'ack',
            requestId: data.requestId,
            result: { state: 'approval-submitted' },
          }),
        );
        // Leave the request in sync snapshots to exercise deduplication after acknowledgement.
        sync(ws);
      }
    }
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
  await page.getByLabel('任务内容').fill('/model');
  await page.getByLabel('任务内容').press('Enter');
  await expect(
    page.getByRole('heading', { name: '选择模型', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /Test alternative/ }),
  ).toBeEnabled();
  await expect(page.getByRole('button', { name: /Hidden/ })).toHaveCount(0);
  assert.equal(
    submitted.size,
    0,
    '/model is a local command and never a model task',
  );
  await page.screenshot({ path: join(artifacts, 'cw-models-mobile.png') });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.screenshot({ path: join(artifacts, 'cw-models-desktop.png') });
  modelListFailure = true;
  await page.getByRole('button', { name: '刷新模型列表' }).click();
  await expect(page.locator('.model-picker').getByRole('alert')).toContainText(
    'model/list unavailable',
  );
  modelListFailure = false;
  await page.getByRole('button', { name: '刷新模型列表' }).click();
  await page.getByRole('button', { name: /Test alternative/ }).click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.model-toggle')).toContainText('test-model-alt');
  await page.reload();
  await expect(page.locator('.model-toggle')).toContainText('test-model-alt');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('任务内容').fill('发送状态测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const progress = page.locator('.thinking');
  await expect(progress).toContainText('正在发送给 Codex…');
  await page.screenshot({ path: join(artifacts, 'cw-sending.png') });
  await page.waitForFunction(
    () => document.querySelector('textarea')?.value === '',
  );
  const requestId = [...submitted][0];
  assert(requestId, 'prompt reaches the relay');
  assert.equal(
    promptCommands.at(-1)?.model,
    'test-model-alt',
    'selected model reaches the prompt',
  );
  for (const ws of controls)
    ws.send(JSON.stringify({ type: 'ack', requestId, result: {} }));
  await expect(progress).toContainText('已发送，等待 Codex 回复…');
  const emit = (seq: number, type: string, data = {}) => {
    for (const ws of controls)
      ws.send(
        JSON.stringify({
          type: 'event',
          event: { seq, type, data, time: seq },
        }),
      );
  };
  emit(1000, 'turn/started');
  await expect(progress).toContainText('已发送，等待 Codex 回复…');
  await page.locator('.model-toggle').click();
  await expect(
    page.getByRole('button', { name: /Test default/ }),
  ).toBeDisabled();
  await page.getByRole('button', { name: '关闭面板' }).click();
  emit(1001, 'item/agentMessage/delta', {
    itemId: 'status-reply',
    delta: '收到消息',
  });
  await expect(progress).toContainText('Codex 正在回复…');
  await page.screenshot({ path: join(artifacts, 'cw-replying.png') });
  emit(1002, 'turn/completed');
  await expect(progress).toHaveCount(0);
  submitted.clear();
  await page.getByLabel('任务内容').fill('提交结果不明测试');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(progress).toContainText('正在发送给 Codex…');
  await page.waitForFunction(
    () => document.querySelector('textarea')?.value === '',
  );
  const unknownRequestId = [...submitted][0];
  assert(unknownRequestId);
  for (const code of ['RESULT_UNKNOWN', 'SESSION_BUSY']) {
    for (const ws of controls)
      ws.send(
        JSON.stringify({
          type: 'error',
          requestId: unknownRequestId,
          error: { code, message: 'synthetic submission error' },
        }),
      );
    await expect(progress).toHaveCount(0);
    if (code === 'RESULT_UNKNOWN')
      await expect(page.locator('.submission-state')).toContainText(
        '任务提交结果待确认',
      );
  }
  await expect(page.locator('.submission-state')).toHaveCount(0);
  await expect(page.getByLabel('任务内容')).toHaveValue('提交结果不明测试');
  submitted.clear();
  const languageDraft = '中英文切换保留草稿 / keep this draft';
  await page.getByLabel('任务内容').fill(languageDraft);
  const returnLatest = page.getByRole('button', {
    name: '返回最新内容',
    exact: true,
  });
  if (await returnLatest.isVisible()) {
    await returnLatest.click();
    await expect(returnLatest).toHaveCount(0);
  }
  let languageAttachCalls = attachCalls;
  const beforeControlSync = controlSyncCalls;
  // Persist a message without delivering a live notification on either channel.
  events.push({
    seq: 8,
    type: 'user',
    data: { text: '刷新补回漏掉的消息' },
    time: 8,
  });
  await expect(
    page.getByText('刷新补回漏掉的消息', { exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '刷新状态', exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel('任务内容')).toHaveValue(languageDraft);
  await expect(
    page.getByText('刷新补回漏掉的消息', { exact: true }),
  ).toBeVisible();
  assert(
    controlSyncCalls > beforeControlSync,
    'refresh confirms session state',
  );
  assert.equal(
    attachCalls,
    languageAttachCalls,
    'manual refresh preserves the active controller',
  );
  // Simulate an OPEN history channel that stops answering while probe succeeds.
  const beforeHistoryReconnect = historyConnections;
  stallHistory = true;
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '刷新状态', exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  await expect(page.getByRole('alert')).toContainText(
    '会话同步未确认，已请求重新连接，请稍后刷新核对。',
  );
  stallHistory = false;
  await expect
    .poll(() => historyConnections)
    .toBeGreaterThan(beforeHistoryReconnect);
  await expect.poll(() => attachCalls).toBeGreaterThan(languageAttachCalls);
  await expect(page.getByLabel('任务内容')).toHaveValue(languageDraft);
  await page.getByRole('button', { name: '刷新状态', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '刷新状态', exact: true }),
  ).toBeEnabled();
  languageAttachCalls = attachCalls;
  await openMenu(page);
  await page.getByLabel('语言 / Language').selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page).toHaveTitle('Remote Codex');
  await expect(
    page.getByRole('navigation', { name: 'Feature menu' }),
  ).toBeVisible();
  await expect(group.locator(':scope > summary')).toContainText('3 items');
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Task', { exact: true })).toHaveValue(
    languageDraft,
  );
  await expect(page.getByText('示例任务', { exact: true })).toBeVisible();
  await expect(page.getByText('任务已完成。', { exact: true })).toBeVisible();
  assert.equal(
    attachCalls,
    languageAttachCalls,
    'language switching does not reconnect',
  );
  await page.getByRole('button', { name: 'Feature menu' }).click();
  await page.getByRole('button', { name: /^Workspace files/ }).click();
  await expect(
    page.getByRole('heading', { name: 'Workspace files' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Upload file', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();
  await page.reload();
  await expect(page.getByLabel('Task', { exact: true })).toHaveValue(
    languageDraft,
  );
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 480 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole('button', { name: 'Feature menu' }).click();
    await expect(page.getByLabel('语言 / Language')).toBeVisible();
    await expect(
      page.getByRole('button', {
        name: 'Switch to Administrator mode',
        exact: true,
      }),
    ).toBeVisible();
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      'English menu has no horizontal overflow',
    );
    await page.screenshot({
      path: join(artifacts, `cw-english-${viewport.width}.png`),
    });
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'Feature menu' }).click();
  await page.getByLabel('语言 / Language').selectOption('zh-CN');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page).toHaveTitle('远程 Codex');
  await expect(group.locator(':scope > summary')).toContainText('3 项');
  await page.keyboard.press('Escape');
  await page.getByLabel('任务内容').fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  const downloadBytes = Buffer.alloc(65539, 255);
  const fileReads: {
    projectId: string;
    path: string;
    offset: number;
    version?: string;
  }[] = [];
  const previewFiles = new Map<string, Buffer>();
  await page.context().route('**/api/v1/hosts/sample/files', async (route) => {
    const data = route.request().postDataJSON();
    if (data.operation !== 'read') return route.continue();
    fileReads.push(data);
    if (data.path === 'docs/missing.txt')
      return route.fulfill({
        headers: { 'X-CoC-Demand': '1' },
        status: 404,
        json: { error: { code: 'NOT_FOUND', message: 'File not found' } },
      });
    const bytes = previewFiles.get(data.path) || downloadBytes;
    const chunk = bytes.subarray(data.offset, data.offset + 65536);
    await route.fulfill({
      headers: { 'X-CoC-Demand': '1' },
      json: {
        data: chunk.toString('base64'),
        size: bytes.length,
        offset: data.offset + chunk.length,
        version: 'report-v1',
      },
    });
  });
  const missingWindow = page.context().waitForEvent('page');
  await page
    .getByRole('link', { name: '预览 docs/missing.txt', exact: true })
    .click();
  const missingPreview = await missingWindow;
  await expect(missingPreview.getByRole('alert')).toContainText('NOT_FOUND');
  await missingPreview.close();
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
  const markdown =
    '# Rendered report\n\n| Result | Value |\n| --- | --- |\n| Status | OK |\n\n```js\nconst safe = true;\n```\n\n<script>window.previewUnsafe = true</script>\n[bad](javascript:alert(1))';
  const plain =
    '<script>window.previewUnsafe = true</script>\n正文 <img src=x onerror=alert(1)>';
  previewFiles.set('docs/report.md', Buffer.from(markdown));
  previewFiles.set('docs/plain.txt', Buffer.from(plain));
  for (const [path, content] of [
    ['docs/report.md', markdown],
    ['docs/plain.txt', plain],
  ]) {
    const opened = page.context().waitForEvent('page');
    await page.getByRole('link', { name: '预览 ' + path, exact: true }).click();
    const preview = await opened;
    await expect(
      preview.getByRole('button', { name: '下载', exact: true }),
    ).toBeEnabled();
    assert.equal(await preview.evaluate(() => window.opener), null);
    if (path.endsWith('.md')) {
      await expect(
        preview.getByRole('heading', { name: 'Rendered report' }),
      ).toBeVisible();
      await expect(preview.locator('table')).toHaveCount(1);
      await expect(preview.locator('pre code')).toContainText(
        'const safe = true;',
      );
      await expect(preview.locator('a[href^="javascript:"]')).toHaveCount(0);
    } else {
      await expect(preview.locator('pre')).toHaveText(content);
      await expect(preview.locator('img')).toHaveCount(0);
    }
    assert.equal(
      await preview.evaluate(() => (window as any).previewUnsafe),
      undefined,
    );
    const saved = preview.waitForEvent('download');
    await preview.getByRole('button', { name: '下载', exact: true }).click();
    assert.equal(readFileSync((await (await saved).path())!, 'utf8'), content);
    await preview.screenshot({
      path: join(
        artifacts,
        path.endsWith('.md')
          ? 'file-markdown-preview.png'
          : 'file-text-preview.png',
      ),
      fullPage: true,
    });
    await preview.close();
  }
  previewFiles.set(
    'docs/pixel.png',
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aEFcAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const wav = Buffer.alloc(44 + 8000, 128);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(8000, 28);
  wav.writeUInt16LE(1, 32);
  wav.writeUInt16LE(8, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(8000, 40);
  previewFiles.set('docs/tone.wav', wav);
  const video = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 32;
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const blobs: Blob[] = [];
    recorder.ondataavailable = (event) => blobs.push(event.data);
    const stopped = new Promise<void>((done) => {
      recorder.onstop = () => done();
    });
    recorder.start();
    const context = canvas.getContext('2d')!;
    context.fillStyle = 'blue';
    context.fillRect(0, 0, 32, 32);
    let frame = 0;
    const animate = setInterval(() => {
      context.fillStyle = frame++ % 2 ? 'red' : 'blue';
      context.fillRect(0, 0, 32, 32);
    }, 50);
    await new Promise((done) => setTimeout(done, 1000));
    clearInterval(animate);
    recorder.stop();
    await stopped;
    stream.getTracks().forEach((track) => track.stop());
    return [...new Uint8Array(await new Blob(blobs).arrayBuffer())];
  });
  previewFiles.set('docs/clip.webm', Buffer.from(video));
  for (const [path, tag] of [
    ['docs/pixel.png', 'img'],
    ['docs/tone.wav', 'audio'],
    ['docs/clip.webm', 'video'],
  ]) {
    await page.getByRole('link', { name: '展开 ' + path, exact: true }).click();
    const media = page.getByLabel('预览 ' + path, { exact: true }).locator(tag);
    await expect(media).toBeVisible();
    if (tag === 'img')
      await expect
        .poll(() =>
          media.evaluate((el) => (el as HTMLImageElement).naturalWidth),
        )
        .toBeGreaterThan(0);
    else {
      await expect(media).toHaveAttribute('controls', '');
      await media.evaluate((el) => (el as HTMLMediaElement).play());
      await expect
        .poll(() =>
          media.evaluate((el) => (el as HTMLMediaElement).currentTime),
        )
        .toBeGreaterThan(0);
    }
    const reads = fileReads.length;
    await page.getByRole('link', { name: '收起 ' + path, exact: true }).click();
    await expect(media).toHaveCount(0);
    await page.getByRole('link', { name: '展开 ' + path, exact: true }).click();
    assert.equal(
      fileReads.length,
      reads,
      'expansion reuses the pinned file snapshot',
    );
    await page.getByRole('link', { name: '收起 ' + path, exact: true }).click();
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
  const newest = page.getByRole('button', {
    name: '返回最新内容',
    exact: true,
  });
  if (await newest.isVisible()) await newest.click();
  const previousMaximum = Math.max(
    ...events.map((event) => event.revision ?? event.seq),
  );
  const changingTool: any = {
    seq: 90,
    revision: 90,
    contentSeq: 90,
    type: 'item/started',
    time: 90,
    data: {
      item: {
        id: 'live-tool',
        type: 'commandExecution',
        command: 'live-tool-test',
        status: 'inProgress',
      },
    },
  };
  (events as any[]).push(changingTool);
  for (const ws of histories)
    ws.send(
      JSON.stringify({
        type: 'event',
        event: changingTool,
        previousRevision: previousMaximum,
        maxRevision: 90,
      }),
    );
  const toolRow = page.locator('.tool-output[data-event-seq="90"]');
  await toolRow.locator('xpath=..').locator(':scope > summary').click();
  await toolRow.locator('summary').click();
  await expect(toolRow).toContainText('tool output 90');
  const pagesBeforeGap = historyPages;
  toolRevision = 91;
  changingTool.revision = 91;
  changingTool.type = 'item/completed';
  changingTool.data.item.exitCode = 0;
  const following: any = {
    seq: 92,
    revision: 92,
    time: 92,
    type: 'item/agentMessage/delta',
    data: { delta: '工具之后的正文' },
  };
  (events as any[]).push(following);
  // Lose the tool completion itself; a newer Agent watermark must recover it.
  for (const ws of histories)
    ws.send(
      JSON.stringify({
        type: 'event',
        event: following,
        previousRevision: 91,
        maxRevision: 92,
      }),
    );
  await expect(toolRow.locator('summary')).toContainText('退出码 0');
  await expect(toolRow).toContainText('tool output 91');
  assert(
    historyPages > pagesBeforeGap,
    'a missing revision triggers incremental recovery',
  );
  const pagesAfterGap = historyPages;
  toolRevision = 93;
  changingTool.revision = 93;
  for (const ws of histories)
    ws.send(
      JSON.stringify({
        type: 'event',
        event: changingTool,
        previousRevision: 92,
        maxRevision: 93,
      }),
    );
  await expect(toolRow).toContainText('tool output 93');
  assert.equal(
    historyPages,
    pagesAfterGap,
    'an unbroken live chain needs no redundant history fetch',
  );
  assert.equal(
    toolReads,
    3,
    'expanded tool content follows each new revision once',
  );
  await page.screenshot({
    path: join(artifacts, 'live-tool-revision-recovery.png'),
    fullPage: true,
  });

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
  await expect(
    page.getByRole('heading', { name: '待授权请求', exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByLabel('所有者密钥').fill('synthetic-owner-secret');
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '待授权请求', exact: true }),
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
  await expect(page.locator('.thinking')).toContainText('正在发送给 Codex…');
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
      if (count === 3 && height === 844) {
        const approvalConnections = attachCalls;
        await openMenu(page);
        await page.getByLabel('语言 / Language').selectOption('en');
        await page.keyboard.press('Escape');
        await expect(
          page.getByText('Request to run a command', { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Allow once', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Deny', exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole('button', { name: 'Next', exact: true }),
        ).toBeVisible();
        assert.equal(
          attachCalls,
          approvalConnections,
          'language switching keeps pending approvals connected',
        );
        await page.getByRole('button', { name: 'Feature menu' }).click();
        await page.getByLabel('语言 / Language').selectOption('zh-CN');
        await page.keyboard.press('Escape');
        await expect(page.getByText('等待你的确认 · 1 / 3')).toBeVisible();
      }
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
  const autoApprove = page.getByRole('checkbox', {
    name: '自动批准当前会话',
    exact: true,
  });
  await expect(autoApprove).not.toBeChecked();
  approvals = [
    {
      approvalId: 'auto-command',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'echo automatic' },
    },
    {
      approvalId: 'auto-file',
      method: 'item/fileChange/requestApproval',
      params: { grantRoot: '/workspace/example' },
    },
    {
      approvalId: 'auto-permissions',
      method: 'item/permissions/requestApproval',
      params: { permissions: { network: { enabled: true } } },
    },
    {
      approvalId: 'auto-submitted',
      method: 'item/commandExecution/requestApproval',
      params: {},
      submitted: true,
    },
    {
      approvalId: 'auto-unsupported',
      method: 'item/tool/requestUserInput',
      params: {},
      unsupported: true,
    },
  ];
  for (const ws of controls) sync(ws);
  await expect(page.getByText('等待你的确认 · 1 / 5')).toBeVisible();
  assert.equal(approvalAnswers.length, 0, 'automatic approval defaults to off');
  await autoApprove.click();
  await expect(autoApprove).toBeChecked();
  await expect.poll(() => approvalAnswers.length).toBe(3);
  assert.deepEqual(
    approvalAnswers.map((answer) => answer.approvalId),
    ['auto-command', 'auto-file', 'auto-permissions'],
  );
  assert(
    approvalAnswers.every(
      (answer) => answer.allow && answer.sessionId === session.id,
    ),
  );
  assert.equal(
    new Set(approvalAnswers.map((answer) => answer.requestId)).size,
    3,
  );
  for (const ws of controls) sync(ws);
  await autoApprove.click();
  await expect(autoApprove).not.toBeChecked();
  await autoApprove.click();
  await expect(autoApprove).toBeChecked();
  await page.waitForTimeout(100);
  assert.equal(
    approvalAnswers.length,
    3,
    'sync replay and toggling do not repeat a decision',
  );
  await autoApprove.click();
  await expect(autoApprove).not.toBeChecked();
  approvals = [
    {
      approvalId: 'auto-lost-ack',
      method: 'item/commandExecution/requestApproval',
      params: { command: 'echo once' },
    },
  ];
  for (const ws of controls) sync(ws);
  await expect(page.getByText('等待你的确认 · 1 / 1')).toBeVisible();
  assert.equal(
    approvalAnswers.length,
    3,
    'disabled switch does not approve new requests',
  );
  const beforeReconnect = attachCalls;
  dropApprovalAck = true;
  await autoApprove.click();
  await expect(autoApprove).toBeChecked();
  await expect.poll(() => attachCalls).toBeGreaterThan(beforeReconnect);
  await page.locator('.auto-approval summary').click();
  await expect(
    page.getByText('Agent 已启用自动批准', { exact: true }),
  ).toBeVisible();
  const approvalDetails = (await page
    .locator('.auto-approval-details')
    .boundingBox())!;
  assert(
    approvalDetails.x >= 0 && approvalDetails.x + approvalDetails.width <= 390,
    'auto-approval scope stays inside the mobile viewport',
  );
  for (const ws of controls) sync(ws);
  await page.waitForTimeout(100);
  assert.equal(
    approvalAnswers.length,
    4,
    'lost acknowledgement and reconnect do not resubmit approval',
  );
  await page.screenshot({
    path: join(artifacts, 'cw-auto-approval-390.png'),
    animations: 'disabled',
  });
  await page.locator('.auto-approval summary').click();
  await page.reload();
  await expect(autoApprove).toBeChecked();
  await expect(page.getByText('等待你的确认 · 1 / 1')).toBeVisible();
  assert.equal(
    approvalAnswers.length,
    4,
    'reload restores the Agent policy without replaying decisions',
  );
  await autoApprove.click();
  await expect(autoApprove).not.toBeChecked();
  await expect(autoApprove).not.toBeChecked();
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
      // Entering history mode changes the header height. Fail once more at
      // the top so the retry starts with a stable layout and scroll position.
      failOlderPageOnce = true;
      const failedCalls = olderPageCalls;
      await historyPage.locator('.messages').evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect.poll(() => olderPageCalls).toBe(failedCalls + 1);
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
      const wheelAtTop = !!size && count === 300;
      if (size && !wheelAtTop) {
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
      const top =
        size && !wheelAtTop
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
      if (wheelAtTop) {
        await expect
          .poll(() =>
            historyPage.locator('.messages').evaluate((el) => el.scrollTop),
          )
          .toBe(0);
        await historyPage.locator('.messages').hover();
        await historyPage.locator('.messages').dispatchEvent('wheel', {
          deltaY: 100,
        });
        await expect(messages).toHaveCount(150);
        await historyPage.mouse.wheel(0, -100);
      }
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
  await page.getByLabel('语言 / Language').selectOption('en');
  const englishMenu = page.getByRole('navigation', { name: 'Feature menu' });
  await expect(
    page.getByRole('heading', { name: 'Administrator sign-in' }),
  ).toBeVisible();
  await expect(page.getByLabel('Owner secret')).toBeVisible();
  await englishMenu
    .getByRole('button', { name: 'Switch to CW mode', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Connect to a remote server' }),
  ).toBeVisible();
  await expect(page.getByLabel('Message to administrator')).toBeVisible();
  await englishMenu
    .getByRole('button', { name: 'Switch to Administrator mode', exact: true })
    .click();
  adminSamples = true;
  await page.getByLabel('Owner secret').fill('synthetic-owner-secret');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Pending access requests' }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'Pending access requests' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('table', { name: 'Pending access requests', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('columnheader', { name: 'Actions', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Approve TABLE001', exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel('Target server TABLE001', { exact: true })
    .selectOption('sample');
  await expect(
    page.getByRole('button', { name: 'Approve TABLE001', exact: true }),
  ).toBeEnabled();
  await expect(
    page.getByLabel('Target server TABLE002', { exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByLabel('Target server TABLE002', { exact: true }),
  ).toHaveValue('sample');
  await expect(page.locator('.request-message').first()).toHaveText(
    adminMessage,
  );
  await page.getByRole('button', { name: 'Feature menu' }).click();
  await englishMenu.getByRole('button', { name: /^API Key/ }).click();
  await expect(
    page.getByRole('heading', { name: 'API Key management' }),
  ).toBeVisible();
  await expect(
    page.getByRole('tab', { name: 'API Key management' }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Key name')).toBeVisible();
  await page.getByRole('button', { name: 'Feature menu' }).click();
  await page.getByLabel('语言 / Language').selectOption('zh-CN');
  await expect(
    page.getByRole('heading', { name: 'API Key 管理' }),
  ).toBeVisible();
  await expect(page.getByRole('tab', { name: 'API Key 管理' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('Escape');
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    for (const [tab, name] of [
      ['pending', '待授权请求'],
      ['authorized', '已授权设备'],
      ['wake', '服务器唤醒配置'],
      ['keys', 'API Key 管理'],
    ]) {
      await page.getByRole('tab', { name, exact: true }).click();
      await expect(
        page.getByRole('tab', { name, exact: true }),
      ).toHaveAttribute('aria-selected', 'true');
      await expect(
        page.getByRole('table', { name, exact: true }),
      ).toBeVisible();
      const table = page.getByRole('table', { name, exact: true });
      const headers = table.locator(':scope > thead > tr > th');
      for (const header of await headers.all()) {
        const button = header.getByRole('button');
        await button.click();
        const direction = await header.getAttribute('aria-sort');
        assert(['ascending', 'descending'].includes(direction || ''));
        await button.click();
        await expect(header).toHaveAttribute(
          'aria-sort',
          direction === 'ascending' ? 'descending' : 'ascending',
        );
      }
      if (tab === 'authorized') {
        await page.getByLabel('折叠方式').selectOption('client');
        const webGroup = table.locator('.device-group').filter({
          has: page
            .locator('summary')
            .filter({ hasText: /^CW · user@example.test/ }),
        });
        await webGroup.locator(':scope > summary').click();
        await expect(webGroup.locator('[data-credential-id]')).toHaveCount(2);
        await expect(
          webGroup.locator('[data-credential-id="web-a"]'),
        ).toContainText('示例服务器');
        await expect(
          webGroup.locator('[data-credential-id="web-b"]'),
        ).toContainText('第二服务器');
        const seenHeader = webGroup.getByRole('columnheader', {
          name: '上次看到',
        });
        await seenHeader.getByRole('button').click();
        if ((await seenHeader.getAttribute('aria-sort')) !== 'ascending')
          await seenHeader.getByRole('button').click();
        await expect(
          webGroup.locator('[data-credential-id]').first(),
        ).toHaveAttribute('data-credential-id', 'web-a');
        await seenHeader.getByRole('button').click();
        await expect(
          webGroup.locator('[data-credential-id]').first(),
        ).toHaveAttribute('data-credential-id', 'web-b');
        if (width === 1280) {
          let revoked = '';
          await page.route('**/api/v1/admin/revoke', async (route) => {
            revoked = route.request().postDataJSON().id;
            await route.fulfill({ json: { ok: true } });
          });
          page.once('dialog', (dialog) => void dialog.accept());
          await webGroup
            .locator('[data-credential-id]')
            .first()
            .getByRole('button', { name: /^撤销/ })
            .click();
          await expect.poll(() => revoked).toBe('web-b');
          await expect(
            webGroup.getByRole('button', { name: /^撤销/ }).first(),
          ).toBeEnabled();
          await page.unroute('**/api/v1/admin/revoke');
        }
        await page
          .locator('.admin-table-scroll')
          .evaluateAll((elements) =>
            elements.forEach((element) => (element.scrollLeft = 0)),
          );
        await page.screenshot({
          path: join(artifacts, `admin-group-client-${width}.png`),
          fullPage: true,
        });
        await page.getByLabel('折叠方式').selectOption('agent');
        const agentGroup = table.locator('.device-group').filter({
          has: page
            .locator('summary')
            .filter({ hasText: /^Agent · 示例服务器/ }),
        });
        await agentGroup.locator(':scope > summary').click();
        await expect(agentGroup.locator('[data-credential-id]')).toHaveCount(3);
        await expect(
          agentGroup.locator('[data-credential-id="agent-a"]'),
        ).toContainText('暂无记录');
      }
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        `${name}: no page overflow at ${width}px`,
      );
      await page
        .locator('.admin-table-scroll')
        .evaluateAll((elements) =>
          elements.forEach((element) => (element.scrollLeft = 0)),
        );
      await page.screenshot({
        path: join(artifacts, `admin-table-${tab}-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      if (width === 390) {
        const region = page.getByRole('region', { name, exact: true });
        await region.focus();
        await region.press('ArrowRight');
        await expect
          .poll(() => region.evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0);
      }
    }
  }
  assert.deepEqual(failures, []);
  console.log(
    'PASS: manual refresh recovers missed history and stalled OPEN channels; all admin headers toggle sorting, Agent/client groups retain independent authorization IDs after sorting, timestamp order and unknown values; Chinese/English switching, persistence, unchanged conversation content and drafts without reconnecting, English mobile/desktop menus, login and admin pages, automatic host/project/session/draft restoration after refresh, offline restoration, removed-project fallback, credential isolation, desktop/mobile chat file downloads with binary integrity, missing-file errors and external-path isolation, full expanded content beyond 128 Ki characters, ticket retry, collapsed consecutive tools, persistent drafts, 0/1/3/10 approvals at mobile/short viewport, CW/admin mode isolation, mode switch layout/focus/login/logout/deep links without reconnecting CW, dialog padding/focus, offline catalog, session connection settings, automatic and manual paged history with cached reload and first visit',
  );
} finally {
  await browser.close();
  for (const ws of sockets) ws.terminate();
  await new Promise<void>((done) => wss.close(() => done()));
  await new Promise<void>((done) => server.close(() => done()));
}

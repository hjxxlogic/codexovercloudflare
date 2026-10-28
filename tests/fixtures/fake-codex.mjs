// Deterministic protocol peer: never executes commands or contacts a model.
import { createInterface } from 'node:readline';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const stateFile = '.fake-external.json';
function externalState() {
  return existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, 'utf8'))
    : {
        items: Array.from({ length: 25 }, (_, i) => ({
          id: 'external-' + i,
          type: 'agentMessage',
          text: 'External message ' + i,
        })),
        queue: [],
        running: true,
      };
}
function externalPage(m) {
  const state = externalState();
  const legacy = m.method === 'thread/turns/list';
  const items = legacy
    ? [
        {
          id: 'external-turn',
          status: state.running ? 'inProgress' : 'completed',
          items: m.params.itemsView === 'summary' ? [] : state.items,
        },
      ]
    : state.items.map((item) => ({ turnId: 'external-turn', item }));
  const asc = m.params.sortDirection === 'asc';
  const cursor = m.params.cursor;
  let index = cursor == null ? (asc ? 0 : items.length - 1) : Number(cursor);
  const entry = items[index];
  const next = index + (asc ? 1 : -1);
  return {
    data: entry ? [entry] : [],
    nextCursor: next >= 0 && next < items.length ? String(next) : null,
    backwardsCursor: entry ? String(index) : null,
  };
}
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.164.0');
  process.exit(0);
}
const send = (d) => console.log(JSON.stringify(d));
const restoredItems = [
  {
    id: 'old-user',
    type: 'userMessage',
    content: [{ type: 'text', text: 'Previous local task' }],
  },
  {
    id: 'old-reply',
    type: 'agentMessage',
    text: '## Restored reply\n\n**Markdown** works.\n\n| File | Status |\n| --- | --- |\n| app.ts | ready |\n\n```ts\nconst restored = true;\n```\n\n[unsafe](javascript:alert(1))',
  },
  {
    id: 'old-command',
    type: 'commandExecution',
    command: 'echo restored',
    aggregatedOutput: 'restored',
    status: 'completed',
  },
];
let nextApproval = 100,
  turn = 0,
  approval;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (!m.method) {
    if (approval) {
      send({
        method: 'item/agentMessage/delta',
        params: {
          delta: m.result?.decision === 'accept' ? 'approved' : 'denied',
        },
      });
      send({
        method: 'turn/completed',
        params: { turn: { id: 'turn-' + turn, status: 'completed' } },
      });
      approval = undefined;
    }
    return;
  }
  if (m.id === undefined) return;
  let result = {};
  if (m.method === 'initialize') result = { userAgent: 'fake-codex' };
  if (m.method === 'thread/start')
    result = { thread: { id: 'thread-' + process.pid, turns: [] } };
  if (m.method === 'thread/list')
    result = {
      data: [
        {
          id: 'local-history',
          name: '本地历史对话',
          preview: 'Previous local task ' + '你好'.repeat(180),
          cwd: process.cwd(),
          updatedAt: 1790000000,
        },
        {
          id: 'external-history',
          name: '外部运行会话',
          preview: 'External Codex writer',
          cwd: process.cwd(),
          updatedAt: 1790000000,
        },
        {
          id: 'foreign-history',
          preview: 'Forbidden project',
          cwd: '/not-allowed',
          updatedAt: 1790000000,
        },
      ],
      nextCursor: m.params.cursor ? null : 'history-page-2',
    };
  if (m.method === 'thread/read')
    result = {
      thread: {
        id: m.params.threadId,
        cwd:
          m.params.threadId === 'foreign-history'
            ? '/not-allowed'
            : process.cwd(),
        turns: [],
        historyMode:
          m.params.threadId === 'external-legacy' ? 'legacy' : 'paginated',
      },
    };
  if (m.method === 'thread/resume') {
    if (m.params.threadId.startsWith('external-')) {
      send({
        id: m.id,
        error: {
          code: -32600,
          message:
            'thread ' + m.params.threadId + ' already has an active writer',
        },
      });
      return;
    }
    if (!m.params.excludeTurns)
      throw new Error('Resume must exclude full history');
    result = {
      thread: { id: m.params.threadId, cwd: process.cwd(), turns: [] },
    };
  }
  if (m.method === 'thread/items/list') {
    if (m.params.threadId === 'large-history' && m.params.limit !== 1)
      throw new Error(
        'Large histories must read one bounded item per local RPC',
      );
    const items =
      m.params.threadId === 'large-history'
        ? Array.from({ length: 510 }, (_, i) => ({
            id: 'large-' + i,
            type: 'agentMessage',
            text: i >= 500 ? '你好'.repeat(180000) : 'Archived message ' + i,
          }))
        : restoredItems;
    const offset = Number(m.params.cursor || 0);
    const descending = [...items].reverse();
    const page = descending.slice(offset, offset + m.params.limit);
    result = {
      data: page.map((item) => ({ item, turnId: 'archived-turn' })),
      nextCursor:
        offset + page.length < items.length
          ? String(offset + page.length)
          : null,
    };
  }
  if (
    m.params?.threadId?.startsWith('external-') &&
    ['turn/start', 'turn/interrupt'].includes(m.method)
  )
    throw new Error('External writer must never be controlled');
  if (m.method === 'model/list') {
    result = {
      data: [
        {
          id: 'test-model-alt',
          model: 'test-model-alt',
          displayName: 'Test alternative',
          isDefault: true,
        },
      ],
      nextCursor: null,
    };
  }
  if (m.method === 'turn/start') {
    turn++;
    result = { turn: { id: 'turn-' + turn, status: 'inProgress' } };
    send({ id: m.id, result });
    send({
      method: 'turn/started',
      params: { turn: result.turn, model: m.params.model },
    });
    const text = m.params.input[0].text;
    if (text.includes('approval')) {
      approval = nextApproval++;
      send({
        id: approval,
        method: 'item/commandExecution/requestApproval',
        params: { command: 'echo fake', cwd: process.cwd() },
      });
    } else if (!text.includes('hold')) {
      for (const delta of 'echo: ' + text)
        send({
          method: 'item/agentMessage/delta',
          params: { itemId: 'reply-' + turn, turnId: 'turn-' + turn, delta },
        });
      send({
        method: 'turn/completed',
        params: { turn: { id: 'turn-' + turn, status: 'completed' } },
      });
    }
    return;
  }
  if (m.method === 'turn/interrupt')
    send({
      method: 'turn/completed',
      params: { turn: { id: 'turn-' + turn, status: 'interrupted' } },
    });
  if (m.params?.threadId?.startsWith('external-')) {
    if (m.method === 'thread/items/list' || m.method === 'thread/turns/list')
      result = externalPage(m);
    if (m.method === 'thread/queue/add') {
      const state = externalState();
      let queued = state.queue.find(
        (q) => q.clientUserMessageId === m.params.clientUserMessageId,
      );
      if (!queued) {
        queued = { id: 'queue-' + state.queue.length, ...m.params };
        state.queue.push(queued);
        writeFileSync(stateFile, JSON.stringify(state));
      }
      result = { queuedSubmission: queued };
      if (m.params.input[0].text === 'lost queue reply') return;
    }
    if (m.method === 'thread/queue/list')
      result = { data: externalState().queue, nextCursor: null };
    if (m.method === 'turn/start' || m.method === 'turn/interrupt')
      throw new Error('External writer must never be controlled');
  }
  send({ id: m.id, result });
});

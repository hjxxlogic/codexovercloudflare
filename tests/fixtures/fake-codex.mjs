// Deterministic protocol peer: never executes commands or contacts a model.
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.164.0');
  process.exit(0);
}
const send = (d) => console.log(JSON.stringify(d));
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
      },
    };
  if (m.method === 'thread/resume')
    result = {
      thread: {
        id: m.params.threadId,
        cwd: process.cwd(),
        turns: [
          {
            items: [
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
            ],
          },
        ],
      },
    };
  if (m.method === 'turn/start') {
    turn++;
    result = { turn: { id: 'turn-' + turn, status: 'inProgress' } };
    send({ id: m.id, result });
    send({ method: 'turn/started', params: { turn: result.turn } });
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
  send({ id: m.id, result });
});

#!/usr/bin/env node
// Observe the C++ CLI launcher without invoking a model or exposing test tickets.
import { writeFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { setTimeout } from 'node:timers';
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.164.0');
  process.exit(0);
}
writeFileSync(
  process.env.COC_TUI_CAPTURE,
  JSON.stringify({
    args: process.argv.slice(2),
    ticket: process.env.COC_REMOTE_TICKET,
  }),
  { mode: 0o600 },
);
if (process.env.COC_TUI_RELIABLE_GATE) {
  const { default: WebSocket } = await import('ws');
  const { existsSync } = await import('node:fs');
  const socket = new WebSocket(
    process.argv[process.argv.indexOf('--remote') + 1],
    {
      headers: { Authorization: 'Bearer ' + process.env.COC_REMOTE_TICKET },
    },
  );
  const messages = [];
  let closed = false;
  socket.on('message', (raw) => messages.push(JSON.parse(String(raw))));
  socket.on('close', () => (closed = true));
  const wait = async (predicate) => {
    const deadline = Date.now() + 45000;
    while (!predicate()) {
      if (closed)
        throw new Error(
          'The local TUI connection was closed during remote recovery',
        );
      if (Date.now() > deadline)
        throw new Error('Reliable TUI response timed out');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  let id = 0;
  const request = async (method, params) => {
    const deadline = Date.now() + 45000;
    for (;;) {
      const requestId = ++id;
      socket.send(JSON.stringify({ id: requestId, method, params }));
      await wait(() => messages.some((message) => message.id === requestId));
      const response = messages.find((message) => message.id === requestId);
      if (!response.error) return response.result;
      if (
        method !== 'model/list' ||
        !response.error.message.includes('temporarily unavailable') ||
        Date.now() >= deadline
      )
        throw new Error(JSON.stringify(response.error));
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  try {
    await wait(() => socket.readyState === WebSocket.OPEN);
    await request('initialize', {
      clientInfo: { name: 'reliable-tui-test', version: '1' },
    });
    socket.send(JSON.stringify({ method: 'initialized', params: {} }));
    const thread = (await request('thread/start', {})).thread.id;
    writeFileSync(
      process.env.COC_TUI_CAPTURE,
      JSON.stringify({ phase: 'connected', thread }),
      { mode: 0o600 },
    );
    await wait(() => existsSync(process.env.COC_TUI_RELIABLE_GATE));
    await request('model/list', {});
    await request('turn/start', {
      threadId: thread,
      input: [{ type: 'text', text: 'reliable-cli-proof' }],
    });
    await wait(() =>
      messages.some((message) => message.method === 'turn/completed'),
    );
    const held = await request('turn/start', {
      threadId: thread,
      input: [{ type: 'text', text: 'hold exact CLI interruption' }],
    });
    await wait(() =>
      messages.some(
        (message) =>
          message.method === 'turn/started' &&
          message.params.turn.id === held.turn.id,
      ),
    );
    if (messages.some((message) => message.coc))
      throw new Error('CoC task metadata leaked into the local Codex TUI');
    const rejectedStart = ++id;
    socket.send(
      JSON.stringify({
        id: rejectedStart,
        method: 'turn/start',
        params: {
          threadId: thread,
          input: [{ type: 'text', text: 'must not replace the held task' }],
        },
      }),
    );
    await wait(() => messages.some((message) => message.id === rejectedStart));
    if (
      messages.find((message) => message.id === rejectedStart)?.error?.data
        ?.code !== 'TURN_BUSY'
    )
      throw new Error('A concurrent start replaced the original active task');
    await request('turn/steer', {
      threadId: thread,
      expectedTurnId: held.turn.id,
      input: [{ type: 'text', text: 'steer the original task' }],
    });
    await request('turn/interrupt', { threadId: thread, turnId: held.turn.id });
    await wait(() =>
      messages.some(
        (message) =>
          message.method === 'turn/completed' &&
          message.params.turn.id === held.turn.id,
      ),
    );
    const cancelTurn = await request('turn/start', {
      threadId: thread,
      input: [
        { type: 'text', text: 'hold exact CLI cancellation notification' },
      ],
    });
    const cancelledRequest = id;
    await wait(() =>
      messages.some(
        (message) =>
          message.method === 'turn/started' &&
          message.params.turn.id === cancelTurn.turn.id,
      ),
    );
    socket.send(
      JSON.stringify({
        method: '$/cancelRequest',
        params: { requestId: cancelledRequest },
      }),
    );
    await wait(() =>
      messages.some(
        (message) =>
          message.method === 'turn/completed' &&
          message.params.turn.id === cancelTurn.turn.id,
      ),
    );
    const approvalTurn = await request('turn/start', {
      threadId: thread,
      input: [{ type: 'text', text: 'approval through native CLI proof' }],
    });
    await wait(() =>
      messages.some(
        (message) => message.method === 'item/commandExecution/requestApproval',
      ),
    );
    const approval = messages.find(
      (message) => message.method === 'item/commandExecution/requestApproval',
    );
    if (approval.coc)
      throw new Error('Approval transport metadata leaked into the TUI');
    socket.send(
      JSON.stringify({ id: approval.id, result: { decision: 'decline' } }),
    );
    await wait(() =>
      messages.some(
        (message) =>
          message.method === 'turn/completed' &&
          message.params.turn.id === approvalTurn.turn.id,
      ),
    );
    const large = await request('initialize', {
      clientInfo: { name: 'delivery-large-result', version: '1' },
    });
    if (large.userAgent !== '你好'.repeat(50000))
      throw new Error(
        'Large reliable result lost content before reaching the TUI',
      );
    const largeResultBytes = Buffer.byteLength(large.userAgent);
    const completed = messages.filter(
      (message) => message.method === 'turn/completed',
    ).length;
    writeFileSync(
      process.env.COC_TUI_CAPTURE,
      JSON.stringify({ phase: 'done', thread, completed, largeResultBytes }),
      { mode: 0o600 },
    );
  } finally {
    socket.close();
  }
}

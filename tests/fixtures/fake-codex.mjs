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
  if (m.method === 'thread/read')
    result = { thread: { id: 'thread-' + process.pid, turns: [] } };
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

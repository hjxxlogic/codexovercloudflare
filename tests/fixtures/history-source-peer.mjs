// Read-only persisted-item peer. Any business or fallback RPC fails the process.
import { createInterface } from 'node:readline';
let reads = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialized') continue;
  let result;
  if (m.method === 'initialize') result = {};
  else if (m.method === 'thread/read') {
    reads++;
    const id = m.params.threadId;
    result = {
      thread: {
        id: id === 'wrong-thread' ? 'other' : id,
        cwd:
          id === 'foreign' || (id === 'rebound' && reads > 1)
            ? '/not-authorized'
            : process.cwd(),
        historyMode:
          id === 'unknown-mode'
            ? 'future-mode'
            : id === 'legacy' || (id === 'changed-mode' && reads > 1)
              ? 'legacy'
              : 'paginated',
      },
    };
    if (id === 'bad-metadata') result = { thread: null };
  } else if (m.method === 'thread/items/read') {
    if (m.params.itemIds.length !== 1) throw new Error('Unbounded item read');
    const id = m.params.itemIds[0];
    if (id === 'unsupported') {
      process.stdout.write(
        JSON.stringify({
          id: m.id,
          error: { code: -32601, message: 'Unsupported' },
        }) + '\n',
      );
      continue;
    }
    const entry = {
      turnId: id === 'wrong-turn' ? 'other' : m.params.turnId,
      item: {
        id: id === 'wrong-item' ? 'other' : id,
        type: 'agentMessage',
        text: '你好🙂',
      },
      completedAtMs: 1,
    };
    result = {
      data:
        id === 'missing' ? [] : id === 'duplicate' ? [entry, entry] : [entry],
    };
    if (id === 'malformed') result = { data: {} };
  } else throw new Error('Unexpected RPC: ' + m.method);
  process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n');
}

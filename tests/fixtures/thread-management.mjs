// Isolated persisted Codex catalog; no model, network, or real user records.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
const file = '.thread-management.json';
if (process.argv.includes('--version')) {
  console.log('codex-cli 0.166.0');
  process.exit(0);
}
for await (const line of createInterface({ input: process.stdin })) {
  const req = JSON.parse(line);
  if (req.id === undefined) continue;
  try {
    if (req.method === 'initialize') {
      console.log(
        JSON.stringify({
          id: req.id,
          result: { userAgent: 'management-fixture' },
        }),
      );
      continue;
    }
    const state = JSON.parse(readFileSync(file, 'utf8'));
    const threads = state.threads;
    const p = req.params;
    let result = {};
    if (req.method === 'thread/list') {
      if (
        !p.cwd &&
        (!Array.isArray(p.modelProviders) ||
          p.modelProviders.length ||
          !p.sourceKinds?.includes('subAgentThreadSpawn'))
      )
        throw new Error(
          'Management catalog must include all providers and subagents',
        );
      const data = threads.filter(
        (t) => !!t.archived === !!p.archived && (!p.cwd || t.cwd === p.cwd),
      );
      // Exercise pagination across both catalogs and explicit subagent inclusion.
      const offset = Number(p.cursor || 0);
      result = {
        data: data.slice(offset, offset + 2),
        nextCursor: offset + 2 < data.length ? String(offset + 2) : null,
      };
    } else if (
      ['thread/archive', 'thread/unarchive', 'thread/delete'].includes(
        req.method,
      )
    ) {
      if (state.unsupported) {
        console.log(
          JSON.stringify({
            id: req.id,
            error: { code: -32601, message: 'Method not found' },
          }),
        );
        continue;
      }
      const ids = new Set([p.threadId]);
      if (req.method !== 'thread/unarchive') {
        let size;
        do {
          size = ids.size;
          for (const t of threads) if (ids.has(t.parentThreadId)) ids.add(t.id);
        } while (size !== ids.size);
      }
      if (state.partial && req.method === 'thread/archive') {
        ids.clear();
        ids.add(p.threadId);
      }
      if (req.method === 'thread/delete')
        state.threads = threads.filter((t) => !ids.has(t.id));
      else
        for (const t of threads)
          if (ids.has(t.id)) t.archived = req.method === 'thread/archive';
      state.mutations = (state.mutations || 0) + 1;
      writeFileSync(file, JSON.stringify(state));
      if (state.dropReply) process.exit(0);
      if (req.method === 'thread/unarchive')
        result = { thread: threads.find((t) => t.id === p.threadId) };
    } else throw new Error('Unexpected method ' + req.method);
    console.log(JSON.stringify({ id: req.id, result }));
  } catch (error) {
    console.log(
      JSON.stringify({
        id: req.id,
        error: { code: -32000, message: String(error) },
      }),
    );
  }
}

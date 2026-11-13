// Isolated browser fixture: deterministic content pages and live notifications.
import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  ConversationView,
  type ContentChunk,
} from '../../apps/web/src/conversation.tsx';
import type { Event } from '../../packages/protocol/src/index.ts';
import '../../apps/web/src/style.css';
import '../../apps/web/src/happier/site.css';
import '../../apps/web/src/happier/session-workspace.css';
import '../../apps/web/src/happier/unified-shell.css';

const fileItem = {
  id: 'files',
  type: 'fileChange',
  status: 'inProgress',
  changes: [
    {
      path: 'src/中文/very-long-directory/conversation.tsx',
      diff: '',
      kind: { type: 'update' },
    },
  ],
};
const mcpItem = {
  id: 'mcp',
  type: 'mcpToolCall',
  server: 'docs',
  tool: 'search',
  status: 'inProgress',
  arguments: null,
  result: null,
};
const tool = (seq: number, item: object, paged = false): Event => ({
  seq,
  time: seq,
  revision: 1,
  type: 'item/started',
  data: { turnId: 'turn', item },
  ...(paged ? { contentSeq: seq } : {}),
});
const initialEvents = [
  tool(1, fileItem, true),
  tool(2, mcpItem, true),
  tool(
    3,
    {
      id: 'cmd',
      type: 'commandExecution',
      command: 'npm run build',
      cwd: '/workspace',
      status: 'inProgress',
    },
    true,
  ),
  tool(4, {
    id: 'dynamic',
    type: 'dynamicToolCall',
    tool: 'inspect',
    arguments: { path: 'src/main.ts' },
    status: 'completed',
    contentItems: [{ type: 'inputText', text: 'Inspection complete' }],
  }),
  tool(5, {
    id: 'web',
    type: 'webSearch',
    query: 'TypeScript docs',
    action: { type: 'search', queries: ['TypeScript docs'] },
    results: [
      {
        title: 'Documentation',
        url: 'https://example.invalid/docs',
        snippet: 'Official docs',
      },
    ],
  }),
  tool(6, {
    id: 'agents',
    type: 'collabAgentToolCall',
    tool: 'wait',
    receiverThreadIds: ['worker'],
    agentsStates: { worker: { status: 'running', message: 'Checking build' } },
  }),
  {
    seq: 7,
    time: 7,
    type: 'turn/plan/updated',
    data: {
      plan: [
        { step: 'Implement', status: 'completed' },
        { step: 'Verify', status: 'inProgress' },
      ],
    },
  } as Event,
  tool(8, { id: 'reason', type: 'reasoning', summary: [], content: [] }),
];
const bodies: Record<number, string> = {
  1: JSON.stringify({
    data: {
      item: {
        ...fileItem,
        changes: [
          {
            ...fileItem.changes[0],
            diff: '@@ -1 +1 @@\n-old\n+streamed 😀 line\n+last line\n',
          },
        ],
      },
    },
  }),
  2: JSON.stringify({
    item: {
      ...mcpItem,
      arguments: { query: '流式😀 search' },
      result: {
        content: [{ type: 'text', text: 'Streamed MCP result\nComplete' }],
      },
    },
  }),
  3: 'building\n{"success":true}\nfinished\n',
};
const prefixes: Record<number, number> = {
  1: bodies[1].indexOf('streamed') + 5,
  2: bodies[2].indexOf('MCP result') + 3,
  3: 12,
};
type Read = { seq: number; offset: number; revision: number };
const state = window as unknown as {
  toolFixture: {
    requests: Read[];
    release: () => void;
    revise: (seq: number) => void;
    notify: () => void;
  };
};
function Fixture() {
  const [events, setEvents] = useState(initialEvents);
  const [chunks, setChunks] = useState<Record<number, ContentChunk>>({});
  const onRead = useCallback(
    (seq: number, offset: number, revision: number) => {
      state.toolFixture.requests.push({ seq, offset, revision });
      if (offset) return;
      const source = bodies[seq];
      const end = prefixes[seq];
      setChunks((previous) => ({
        ...previous,
        [seq]: {
          text: source.slice(0, end),
          nextOffset: end,
          more: true,
          revision,
        },
      }));
    },
    [],
  );
  state.toolFixture = {
    requests: state.toolFixture?.requests || [],
    release: () =>
      setChunks((previous) =>
        Object.fromEntries(
          Object.entries(previous).map(([seq, chunk]) => [
            seq,
            {
              text: bodies[Number(seq)],
              nextOffset: bodies[Number(seq)].length,
              more: false,
              revision: chunk.revision,
            },
          ]),
        ),
      ),
    revise: (seq) => {
      bodies[seq] = JSON.stringify({
        ...fileItem,
        status: 'completed',
        changes: [
          {
            ...fileItem.changes[0],
            diff: '@@ -1 +1 @@\n-old\n+revision TWO\n',
          },
        ],
      });
      prefixes[seq] = bodies[seq].length - 3;
      setEvents((previous) =>
        previous.map((event) =>
          event.seq === seq
            ? {
                ...event,
                revision: 2,
                type: 'item/completed',
                data: { item: { ...fileItem, status: 'completed' } },
              }
            : event,
        ),
      );
    },
    notify: () =>
      setEvents((previous) => [
        ...previous,
        {
          seq: 20,
          time: 20,
          type: 'item/mcpToolCall/progress',
          data: { itemId: 'mcp', message: 'Live progress' },
        },
        {
          seq: 21,
          time: 21,
          type: 'item/reasoning/summaryTextDelta',
          data: { itemId: 'reason', summaryIndex: 0, delta: 'Live reasoning' },
        },
      ]),
  };
  return (
    <main className="cw-workbench">
      <div className="happier-cw">
        <div
          className="conversation"
          style={{ maxWidth: 900, margin: '30px auto' }}
        >
          <ConversationView events={events} chunks={chunks} onRead={onRead} />
        </div>
      </div>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);

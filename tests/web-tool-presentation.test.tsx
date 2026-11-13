import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Event } from '../packages/protocol/src/index.ts';
import {
  streamingJson,
  itemFromValue,
} from '../apps/web/src/streaming-json.ts';
import {
  toolModel,
  toolCopy,
  toolStatus,
  toolItemTypes,
} from '../apps/web/src/tool-model.ts';
import { ToolBody, ToolValue } from '../apps/web/src/tool-presentation.tsx';
import { eventTitle } from '../apps/web/src/conversation.tsx';
import { visibleEvents } from '../apps/web/src/events.ts';

const event = (
  item: Record<string, unknown>,
  extra: Partial<Event> = {},
): Event => ({
  seq: 1,
  time: 1,
  type: 'item/started',
  data: { turnId: 'turn', item: { id: 'tool', ...item } },
  ...extra,
});

describe('streaming tool JSON', () => {
  const item = {
    type: 'mcpToolCall',
    arguments: { query: '中😀\\path\n"quoted"' },
    result: { content: [{ type: 'text', text: '正文\n尾部' }] },
  };
  it.each([item, { item }, { data: { item }, seq: 1 }])(
    'decodes every valid prefix without raw escapes or replacement characters',
    (body) => {
      const source = JSON.stringify(body);
      for (let end = 1; end <= source.length; end++) {
        const parsed = streamingJson(source.slice(0, end));
        expect(parsed, `prefix ${end}`).toBeDefined();
        const value = itemFromValue(parsed?.value);
        const query = (value?.arguments as { query?: string })?.query;
        if (query !== undefined)
          expect(item.arguments.query.startsWith(query)).toBe(true);
      }
      expect(streamingJson(source)).toEqual({ value: body, complete: true });
    },
  );
  it.each([
    '{"a":01}',
    '{"a":"bad\\x"}',
    '{"a":true,}',
    '{"a":1} trailing',
    '{"a":"\n"}',
  ])('rejects invalid JSON %s', (source) => {
    expect(streamingJson(source)).toBeUndefined();
  });
  it('handles truncated escapes, scalars and deeply nested input safely', () => {
    expect(streamingJson('{"a":"ok\\uD83D')).toMatchObject({
      value: { a: 'ok' },
      complete: false,
    });
    expect(streamingJson('{"a":tru')).toMatchObject({
      value: {},
      complete: false,
    });
    expect(streamingJson('['.repeat(1000))).toBeUndefined();
    const value = streamingJson('{"__proto__":{"polluted":true}}')?.value;
    expect(Object.hasOwn(value as object, '__proto__')).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it('shows a partial file diff using metadata paths before the path field arrives', () => {
    const e = event(
      {
        type: 'fileChange',
        changes: [
          { path: 'a.ts', diff: '' },
          { path: 'b.ts', diff: '' },
        ],
      },
      { contentSeq: 1 },
    );
    const model = toolModel(e, '{"changes":[{"diff":"@@ -1 +1 @@\\n-old\\n+ne');
    expect(model.item?.changes).toEqual([
      { path: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+ne' },
      { path: 'b.ts', diff: '' },
    ]);
  });
  it('keeps the tool type stable while its JSON type field is incomplete', () => {
    expect(
      toolModel(
        event({ type: 'fileChange' }, { contentSeq: 1 }),
        '{"type":"fileCh',
      ).item?.type,
    ).toBe('fileChange');
  });
  it('copies visible tool text and preserves arbitrary user field names', () => {
    const value = toolCopy({
      type: 'mcpToolCall',
      tool: 'inspect',
      result: { id: 'user-id', type: 'domain-value', data: 'kept' },
    });
    expect(value).toContain('id: user-id');
    expect(value).toContain('data: kept');
    expect(value).not.toContain('"result"');
  });
  it('decodes wrapped command output but keeps arbitrary JSON output intact', () => {
    const e = event(
      { type: 'commandExecution', command: 'build', status: 'inProgress' },
      { contentSeq: 1 },
    );
    expect(
      toolModel(e, '{"aggregatedOutput":"hello\\nwor').item?.aggregatedOutput,
    ).toBe('hello\nwor');
    const raw = '{"success":true,"count":3}';
    expect(toolModel(e, raw).item?.aggregatedOutput).toBe(raw);
    expect(
      toolModel(
        e,
        JSON.stringify({
          type: 'commandExecution',
          aggregatedOutput: 'old',
          status: 'completed',
        }),
      ).item?.status,
    ).toBe('inProgress');
  });
});

describe('tool activity formatting', () => {
  it('retains every supported inline item type and unknown future tools', () => {
    for (const type of [...toolItemTypes, 'futureTool']) {
      expect(visibleEvents([event({ type })])).toHaveLength(1);
      expect(() =>
        renderToStaticMarkup(<ToolBody item={{ type }} />),
      ).not.toThrow();
    }
    expect(
      visibleEvents([
        event({ type: 'agentMessage' }),
        event({ type: 'userMessage' }, { seq: 2 }),
      ]),
    ).toEqual([]);
  });
  it.each([
    [{ status: 'failed' }, '失败'],
    [{ status: 'declined' }, '已拒绝'],
    [{ status: 'interrupted' }, '已中断'],
    [{ success: false }, '失败'],
    [{ result: { isError: true } }, '失败'],
    [{ exitCode: 1 }, '失败'],
    [{ status: 'pending' }, '待执行'],
    [{ status: 'completed' }, '已完成'],
  ])(
    'formats lifecycle status without calling failures completed',
    (item, expected) => {
      expect(toolStatus(item, true)).toBe(expected);
      expect(
        eventTitle(
          event(
            { type: 'mcpToolCall', server: 'docs', tool: 'search', ...item },
            { type: 'item/completed' },
          ),
        ),
      ).toContain(expected);
    },
  );
  it('renders MCP arguments, text, structured results, progress and errors', () => {
    const html = renderToStaticMarkup(
      <ToolBody
        item={{
          type: 'mcpToolCall',
          arguments: { query: 'test' },
          progress: 'working',
          result: {
            content: [{ type: 'text', text: 'result text' }],
            structuredContent: { count: 2 },
          },
          error: { message: 'bad request' },
        }}
      />,
    );
    for (const value of [
      '参数',
      'query',
      'test',
      'working',
      'result text',
      'count',
      'bad request',
    ])
      expect(html).toContain(value);
    expect(html).not.toContain('&quot;content&quot;');
  });
  it('renders plans, agent messages, image paths and unknown tools', () => {
    expect(
      renderToStaticMarkup(
        <ToolBody
          item={{
            type: 'planUpdate',
            plan: [{ step: 'Build', status: 'inProgress' }],
          }}
        />,
      ),
    ).toContain('Build');
    expect(
      renderToStaticMarkup(
        <ToolBody
          item={{
            type: 'collabAgentToolCall',
            agentsStates: { worker: { status: 'completed', message: 'Done' } },
          }}
        />,
      ),
    ).toContain('Done');
    expect(
      renderToStaticMarkup(
        <ToolBody
          item={{ type: 'imageGeneration', savedPath: '/workspace/image.png' }}
        />,
      ),
    ).toContain('/workspace/image.png');
    expect(
      renderToStaticMarkup(
        <ToolBody item={{ type: 'futureTool', newField: 'kept' }} />,
      ),
    ).toContain('kept');
  });
  it('escapes tool content and does not load external images or unsafe links', () => {
    const html = renderToStaticMarkup(
      <ToolValue
        value={[
          { url: 'javascript:alert(1)', title: '<script>' },
          { type: 'inputImage', imageUrl: 'https://external.invalid/a.png' },
        ]}
      />,
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
    expect(html).toContain('href="https://external.invalid/a.png"');
  });
  it('updates a plan in place while preserving turn and reference boundaries', () => {
    const first: Event = {
      seq: 1,
      time: 1,
      type: 'turn/plan/updated',
      data: { plan: [{ step: 'Build', status: 'inProgress' }] },
    };
    const last = {
      ...first,
      seq: 2,
      data: { plan: [{ step: 'Build', status: 'completed' }] },
    };
    expect(visibleEvents([first, last])).toEqual([{ ...last, seq: 1 }]);
    expect(
      visibleEvents([
        first,
        { seq: 2, time: 2, type: 'turn/completed', data: {} },
        { ...last, seq: 3 },
      ]),
    ).toHaveLength(3);
    const referenced = event({ type: 'mcpToolCall' }, { contentSeq: 1 });
    expect(
      visibleEvents([
        referenced,
        {
          seq: 2,
          time: 2,
          type: 'item/mcpToolCall/progress',
          data: { itemId: 'tool', message: 'working' },
        },
      ]),
    ).toMatchObject([
      { seq: 1, contentSeq: 1, data: { item: { progress: 'working' } } },
    ]);
  });
  it('streams MCP progress and plan/reasoning deltas into stable item rows', () => {
    const started = event({ type: 'mcpToolCall', tool: 'search' });
    const progress = (seq: number, message: string): Event => ({
      seq,
      time: seq,
      type: 'item/mcpToolCall/progress',
      data: { itemId: 'tool', message },
    });
    const result = visibleEvents([
      started,
      progress(2, 'first'),
      progress(3, 'second'),
      event(
        { type: 'mcpToolCall', status: 'completed' },
        { seq: 4, type: 'item/completed' },
      ),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      seq: 1,
      data: { item: { progress: 'first\nsecond' } },
    });
    for (const [type, deltaType, field] of [
      ['plan', 'item/plan/delta', 'text'],
      ['reasoning', 'item/reasoning/summaryTextDelta', 'summary'],
      ['reasoning', 'item/reasoning/textDelta', 'content'],
    ]) {
      const events = visibleEvents([
        event({ type }),
        {
          seq: 2,
          time: 2,
          type: deltaType,
          data: { itemId: 'tool', delta: 'hello' },
        },
        {
          seq: 3,
          time: 3,
          type: deltaType,
          data: { itemId: 'tool', delta: ' world' },
        },
      ]);
      expect(events).toHaveLength(1);
      expect((events[0].data as any).item[field]).toEqual(
        field === 'text' ? 'hello world' : ['hello world'],
      );
    }
  });
});

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownRenderer } from '../apps/web/src/markdown/renderer.tsx';
import { commandEvents } from '../apps/web/src/workbench/output.tsx';
import { readPreferences } from '../apps/web/src/workbench/workbench.tsx';
import {
  terminalCommandSchema,
  operationWrite,
} from '../packages/protocol/src/index.ts';
import type { Event } from '../packages/protocol/src/index.ts';
function render(text: string, scope = 'test') {
  return renderToStaticMarkup(<MarkdownRenderer text={text} scope={scope} />);
}
describe('shared Markdown rendering', () => {
  it('keeps raw HTML and executable links inert', () => {
    const html = render(
      '<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![private](https://example.invalid/pixel)',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href="javascript:');
    expect(html).not.toContain('<img');
  });
  it('scopes headings, footnotes and local anchors', () => {
    const text = '# 标题\n\n[go](#标题)\n\nFootnote[^a]\n\n[^a]: Details';
    const first = render(text, 'first'),
      second = render(text, 'second');
    expect(first).toContain('id="first-heading-0"');
    expect(first).toContain('href="#first-heading-0"');
    expect(first).toContain('first-fn-a');
    expect(second).not.toContain('first-heading-0');
  });
  it('renders callouts and explicit folding as components', () => {
    const html = render(
      '> [!WARNING]\n> Danger\n\n:::details More\n\nBody\n\n:::',
    );
    expect(html).toContain('callout-warning');
    expect(html).toContain('<summary>More</summary>');
    expect(html).toContain('<details>');
  });
  it('keeps code literals and incomplete extensions readable', () => {
    const html = render(
      '```text\n$code$\n[!NOTE]\n:::details Raw\n```\n\n:::details Incomplete',
    );
    expect(html).not.toContain('callout-note');
    expect(html).not.toContain('<details>');
    expect(html).toContain('$code$');
    const math = render('Price $100，code `$x$`. Formula $x^2$.');
    expect(math).toContain('Price $100');
    expect(math).toContain('x^2');
    expect(math).toContain('inline-math');
    expect(html).toContain(':::details Incomplete');
  });
});
describe('workbench boundaries', () => {
  it('merges command lifecycle without collecting unrelated tool contents', () => {
    const event = (seq: number, type: string, data: unknown): Event =>
      ({ seq, type, data, time: 1 }) as Event;
    const result = commandEvents([
      event(1, 'item/started', {
        item: { id: 'cmd', type: 'commandExecution', command: 'pwd' },
      }),
      event(2, 'item/commandExecution/outputDelta', {
        itemId: 'cmd',
        delta: '/project',
      }),
      event(3, 'item/completed', {
        item: { id: 'cmd', type: 'commandExecution', exitCode: 0 },
      }),
      event(4, 'item/completed', { item: { id: 'file', type: 'fileChange' } }),
    ]);
    expect(result).toHaveLength(1);
    expect((result[0].data as any).item.aggregatedOutput).toBe('/project');
  });
  it('bounds persisted layout and ignores unsupported settings', () => {
    vi.stubGlobal('localStorage', {
      getItem: () =>
        JSON.stringify({
          theme: 'injected',
          width: 99999,
          height: -5,
          density: 'compact',
        }),
    });
    expect(readPreferences()).toMatchObject({
      theme: 'system',
      width: 360,
      height: 160,
      density: 'compact',
    });
    vi.unstubAllGlobals();
  });
});

it('requires bounded terminal input, a runtime and controller proof', () => {
  expect(
    terminalCommandSchema.safeParse({ operation: 'input', projectId: 'p' })
      .success,
  ).toBe(false);
  expect(
    terminalCommandSchema.safeParse({ operation: 'info', projectId: 'p' })
      .success,
  ).toBe(true);
  expect(operationWrite('terminal', { operation: 'open' })).toBe(true);
  expect(operationWrite('terminal', { operation: 'close' })).toBe(true);
  expect(operationWrite('terminal', { operation: 'input' })).toBe(false);
});

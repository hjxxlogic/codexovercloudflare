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
  it('keeps conversation messages free of document controls', () => {
    expect(render('# Answer\n\nText')).not.toContain('document-tools');
    expect(
      renderToStaticMarkup(<MarkdownRenderer text="# File" tools />),
    ).toContain('document-tools');
  });
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
  it('supports OpenAI TeX delimiters without parsing math as Markdown', () => {
    const html = render(String.raw`\[
L(b)=\ln\frac{P(b=0\mid y)}{P(b=1\mid y)}
\] 本次没有覆盖的位置取 \(L_{i,\mathrm{new}}^{(t)}=0\)。`);
    expect(html.match(/class="display-math"/g)).toHaveLength(1);
    expect(html.match(/class="inline-math"/g)).toHaveLength(1);
    expect(html).toContain(String.raw`L_{i,\mathrm{new}}^{(t)}=0`);
    expect(html).toContain(String.raw`\ln\frac`);
    expect(html).not.toContain('<em>');
    expect(html).toContain('本次没有覆盖的位置取');
    const aligned = render(
      String.raw`\[\begin{aligned}a_i&amp;=1\\b_j&amp;=2\end{aligned}\]`,
    );
    expect(aligned).toContain('class="display-math"');
    expect(aligned).toContain(String.raw`1\\b_j`);
  });
  it('preserves code, escaped delimiters and incomplete streamed formulas', () => {
    const html = render(
      'Inline code `\\(x_i\\)`.\n' +
        String.raw`
~~~text
\[
x_i
\]
~~~

\\(literal\\) and \(incomplete and $100.`,
    );
    expect(html).not.toContain('class="inline-math"');
    expect(html).not.toContain('class="display-math"');
    expect(html).toContain('$100');
    expect(html).toContain('incomplete');
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
      width: 640,
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

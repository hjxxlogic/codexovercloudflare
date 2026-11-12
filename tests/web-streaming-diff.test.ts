import { describe, expect, it } from 'vitest';
import { streamingDiffText } from '../apps/web/src/streaming-diff.ts';

const patch =
  'diff --git a/路径.py b/路径.py\n@@ -1 +1 @@\n-old\\path\n+"新值"\t😀\n';
describe('streamed diff history', () => {
  it('keeps plain unified diffs unchanged', () => {
    expect(streamingDiffText(patch)).toBe(patch);
    expect(streamingDiffText('')).toBe('');
  });
  it.each([
    JSON.stringify({ data: { diff: patch }, seq: 42 }),
    JSON.stringify({ diff: patch }),
    '{"data":{"diff":' +
      JSON.stringify(patch).replace('😀', '\\ud83d\\ude00') +
      '}}',
    JSON.stringify({
      ignored: [{ data: { diff: 'wrong' } }],
      data: { other: '"diff":"wrong"', diff: patch },
    }),
  ])(
    'decodes every partial JSON prefix without exposing the envelope: %s',
    (encoded) => {
      let previous = '';
      for (let end = 1; end <= encoded.length; end++) {
        const text = streamingDiffText(encoded.slice(0, end));
        expect(patch.startsWith(text)).toBe(true);
        expect(text.startsWith(previous)).toBe(true);
        expect(text).not.toMatch(/[\uD800-\uDBFF]$/);
        previous = text;
      }
      expect(previous).toBe(patch);
    },
  );
  it.each([
    '{',
    '{"data":{',
    '{"data":{"diff":"\\u12',
    '{"data":{"diff":"\\',
    '{"item":{"diff":"wrong"}}',
    '{"data":[{"diff":"wrong"}]}',
  ])('hides incomplete metadata and unrelated fields: %s', (text) => {
    expect(streamingDiffText(text)).toBe('');
  });
  it('does not interpret escaped source text as JSON structure', () => {
    const text = '+{"data":{"diff":"this is source code"}}\n';
    expect(streamingDiffText(JSON.stringify({ data: { diff: text } }))).toBe(
      text,
    );
  });
});

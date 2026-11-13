import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileChanges, diffStats } from '../apps/web/src/file-changes.ts';
import { FileChanges } from '../apps/web/src/conversation.tsx';

const changes = [
  {
    path: 'src/中文.ts',
    kind: { type: 'update', move_path: 'src/new.ts' },
    diff: '--- a/src/中文.ts\n+++ b/src/new.ts\n@@ -1 +1,2 @@\n-old\n+new\n+extra\n',
  },
  { path: 'new.txt', kind: { type: 'add' }, diff: '+hello\n' },
  { path: 'old.txt', kind: { type: 'delete' }, diff: '-bye\n' },
];

describe('file change tool presentation', () => {
  it.each([
    { type: 'fileChange', changes },
    { item: { type: 'fileChange', changes } },
    { data: { item: { type: 'fileChange', changes } }, seq: 1 },
  ])('reads native history representations', (value) => {
    expect(fileChanges(JSON.stringify(value))).toEqual(changes);
  });

  it('does not silently drop malformed entries or parse partial JSON', () => {
    expect(fileChanges('{"changes":[')).toBeUndefined();
    expect(
      fileChanges(JSON.stringify({ changes: [...changes, null] })),
    ).toBeUndefined();
    expect(
      fileChanges(JSON.stringify({ changes: [{ path: 'missing diff' }] })),
    ).toBeUndefined();
    expect(fileChanges('{"changes":[]}')).toEqual([]);
    expect(fileChanges('{"other":{"changes":[]}}')).toBeUndefined();
  });

  it('counts content lines without including unified diff headers', () => {
    expect(diffStats(changes[0].diff)).toEqual({ added: 2, removed: 1 });
    expect(diffStats('+++value\n---value\n unchanged\n')).toEqual({
      added: 1,
      removed: 1,
    });
    expect(diffStats('@@ -1 +1 @@\n--- removed\n+++ added\n')).toEqual({
      added: 1,
      removed: 1,
    });
  });

  it('renders paths, operations, counts and colored patches with escaped content', () => {
    const html = renderToStaticMarkup(<FileChanges changes={changes} />);
    expect(html).toContain('src/中文.ts');
    expect(html).toContain('→ src/new.ts');
    expect(html).toContain('移动');
    expect(html).toContain('新增');
    expect(html).toContain('删除');
    expect(html).toContain('+2');
    expect(html).toContain('−1');
    expect(html).toContain('class="diff-add"');
    expect(html).not.toContain('&quot;changes&quot;');
    const escaped = renderToStaticMarkup(
      <FileChanges
        changes={[{ path: '<script>', diff: '+<script>alert(1)</script>' }]}
      />,
    );
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
  });
});

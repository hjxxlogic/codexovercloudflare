import { describe, expect, it } from 'vitest';
import { translate } from '../apps/web/src/i18n.ts';
import { english } from '../apps/web/src/translations.ts';

describe('web interface languages', () => {
  it('translates interface labels and keeps Chinese available', () => {
    expect(translate('加载更早内容', 'en')).toBe('Load earlier content');
    expect(translate('加载更早内容', 'zh-CN')).toBe('加载更早内容');
  });
  it('reorders placeholders without interpreting file names or replacement characters', () => {
    const path = '报告 $& {0}.txt';
    expect(
      translate(
        '确认覆盖 {0} 的远程项目文件“{1}{2}”？',
        'en',
        '主机',
        'docs/',
        path,
      ),
    ).toBe(`Overwrite remote project file “docs/${path}” on 主机?`);
  });
  it('translates previously stored interface notices with dynamic values', () => {
    expect(translate('正在下载 报告.txt…', 'en')).toBe('Downloading 报告.txt…');
    expect(translate('文件超过 20 MiB 上限。', 'en')).toBe(
      'The file exceeds the 20 MiB limit.',
    );
    expect(translate('下载失败：NOT_FOUND: File not found', 'en')).toBe(
      'Download failed: NOT_FOUND: File not found',
    );
  });
  it('keeps unknown text, identifiers and error details intact', () => {
    for (const text of [
      'constructor',
      'toString',
      '/项目/report.txt',
      'HOST_OFFLINE: unavailable',
      '未登记的远程错误',
    ])
      expect(translate(text, 'en')).toBe(text);
  });
  it('provides nonempty English text with the same placeholders for every entry', () => {
    const slots = (value: string) =>
      [...value.matchAll(/\{\d+\}/g)].map((match) => match[0]).sort();
    for (const [source, translation] of Object.entries(english)) {
      expect(translation.trim(), source).not.toBe('');
      expect(slots(translation), source).toEqual(slots(source));
      expect(translation, source).not.toMatch(/\p{Script=Han}/u);
    }
  });
});

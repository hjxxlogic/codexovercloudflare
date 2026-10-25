import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  FileContext,
  fileReferences,
  projectFilePath,
} from '../apps/web/src/file-links.tsx';
import { ConversationView } from '../apps/web/src/conversation.tsx';
import { downloadFile } from '../apps/web/src/download.ts';

const root = '/workspace/example';
describe('chat file paths', () => {
  it('resolves absolute, relative, encoded and editor paths within the project', () => {
    for (const path of [
      'docs/report.txt',
      './docs/report.txt',
      `${root}/docs/report.txt:12:3`,
      'file:///workspace/example/docs/report.txt#L12-L20',
      'docs/../docs/report.txt',
      'docs/report.txt:12',
    ])
      expect(projectFilePath(path, root)).toBe('docs/report.txt');
    expect(projectFilePath(`${root}/docs/my%20report.txt`, root)).toBe(
      'docs/my report.txt',
    );
  });
  it('resolves Windows drive paths only inside the selected Windows project', () => {
    const windowsRoot = 'C:\\Projects\\Demo';
    for (const path of [
      'C:\\Projects\\Demo\\docs\\report.txt:12',
      'c:/projects/demo/docs/report.txt',
      'file:///C:/Projects/Demo/docs/report.txt#L12',
      'docs\\report.txt',
    ])
      expect(projectFilePath(path, windowsRoot)).toBe('docs/report.txt');
    for (const path of [
      'D:/Projects/Demo/report.txt',
      'C:/Projects/Demo-other/report.txt',
      'C:/Projects/Demo/../secret',
      '\\\\server\\share\\secret.txt',
      'file://server/share/secret.txt',
      'C:relative.txt',
      'report.txt:stream',
      'https://example.com/a.txt',
    ])
      expect(projectFilePath(path, windowsRoot)).toBeNull();
    expect(fileReferences('C:\\Projects\\Demo\\report.txt:12')).toEqual([
      { index: 0, text: 'C:\\Projects\\Demo\\report.txt:12' },
    ]);
  });
  it('rejects external URLs, project prefix collisions and escaping paths', () => {
    for (const path of [
      'https://example.com/a.txt',
      'javascript:alert(1)',
      '/workspace/example-other/a.txt',
      '../secret',
      `${root}/../secret`,
      '%2e%2e/secret',
      'folder\\file',
      '#L12',
      'file://other/etc/passwd',
      '/etc/passwd',
      'bad%ZZ',
      'dir/',
    ])
      expect(projectFilePath(path, root)).toBeNull();
  });
  it('finds prose paths without sentence punctuation or pieces of external URLs', () => {
    expect(
      fileReferences('下载 /workspace/example/a.zip，或 docs/report.txt:12。'),
    ).toEqual([
      { index: 3, text: '/workspace/example/a.zip' },
      { index: 30, text: 'docs/report.txt:12' },
    ]);
    expect(fileReferences('https://example.com/a.txt')).toEqual([]);
  });
  it('handles long streamed prose without treating it as a path', () => {
    expect(fileReferences('完整正文'.repeat(32768))).toEqual([]);
    expect(fileReferences('完整正文'.repeat(32768) + '.')).toEqual([]);
  });
  it('renders user, Markdown, inline-code and plain paths using the session project', () => {
    const html = renderToStaticMarkup(
      <FileContext.Provider
        value={{ host: 'sample', project: 'project', root }}
      >
        <ConversationView
          chunks={{}}
          onRead={() => {}}
          events={[
            {
              seq: 1,
              time: 1,
              type: 'user',
              data: { text: '读取 docs/user.txt' },
            },
            {
              seq: 2,
              time: 2,
              type: 'item/agentMessage/delta',
              data: {
                delta:
                  '[`报告`](/workspace/example/report.txt:12) `docs/code.txt` docs/plain.txt\n\n[外网](https://example.com/a.txt) [外部文件](/etc/passwd)\n\n```sh\ncat docs/script.txt\n```',
              },
            },
          ]}
        />
      </FileContext.Provider>,
    );
    for (const path of [
      'docs/user.txt',
      'report.txt',
      'docs/code.txt',
      'docs/plain.txt',
    ])
      expect(html).toContain(`aria-label="下载 ${path}"`);
    expect(html).toContain('href="https://example.com/a.txt"');
    expect(html).not.toContain('href="/etc/passwd"');
    expect(html).toContain('下载 docs/script.txt');
  });
});

describe('shared browser download', () => {
  afterEach(() => vi.unstubAllGlobals());
  function browser() {
    const click = vi.fn();
    const link = { click, remove: vi.fn(), href: '', download: '' };
    vi.stubGlobal('document', {
      createElement: () => link,
      body: { appendChild: vi.fn() },
    });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(globalThis, 'setTimeout').mockReturnValue(0 as never);
    return link;
  }
  afterEach(() => vi.restoreAllMocks());
  it('pins the file version and saves all chunks including binary content', async () => {
    const link = browser();
    const bytes = Buffer.alloc(65539, 255);
    const requests: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const data = JSON.parse(init.body);
        requests.push(data);
        const offset = data.offset as number;
        const chunk = bytes.subarray(offset, offset + 65536);
        return new Response(
          JSON.stringify({
            data: chunk.toString('base64'),
            size: bytes.length,
            offset: offset + chunk.length,
            version: 'v1',
          }),
        );
      }),
    );
    await downloadFile(
      'sample',
      'project',
      'docs/report.bin',
      new AbortController().signal,
    );
    expect(requests).toEqual([
      {
        projectId: 'project',
        operation: 'read',
        path: 'docs/report.bin',
        offset: 0,
      },
      {
        projectId: 'project',
        operation: 'read',
        path: 'docs/report.bin',
        offset: 65536,
        version: 'v1',
      },
    ]);
    expect(link.download).toBe('report.bin');
    expect(link.click).toHaveBeenCalledOnce();
    const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(bytes);
  });
  it('does not save a file if its version changes during transfer', async () => {
    const link = browser();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const { offset } = JSON.parse(init.body);
        const chunk = Buffer.alloc(offset ? 1 : 65536);
        return new Response(
          JSON.stringify({
            data: chunk.toString('base64'),
            size: 65537,
            offset: offset + chunk.length,
            version: offset ? 'v2' : 'v1',
          }),
        );
      }),
    );
    await expect(
      downloadFile(
        'sample',
        'project',
        'report.bin',
        new AbortController().signal,
      ),
    ).rejects.toThrow('下载内容发生变化');
    expect(link.click).not.toHaveBeenCalled();
  });
});

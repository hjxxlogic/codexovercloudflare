import { expect, it, vi } from 'vitest';
const query = vi.hoisted(() => vi.fn());
vi.mock('../apps/web/src/api.ts', () => ({ queryApi: query }));
import { readFile } from '../apps/web/src/download.ts';
it('rejects an oversized preview from its first response before reading more chunks', async () => {
  query.mockResolvedValue({
    size: 2 * 1024 * 1024,
    version: 'v1',
    offset: 65536,
    data: '',
  });
  await expect(
    readFile(
      'host',
      'project',
      'large.txt',
      new AbortController().signal,
      undefined,
      1024 * 1024,
    ),
  ).rejects.toThrow('文件超过预览上限');
  expect(query).toHaveBeenCalledTimes(1);
});

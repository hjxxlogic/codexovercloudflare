import { api } from './api.ts';

const chunkSize = 64 * 1024;
export async function downloadFile(
  host: string,
  project: string,
  remotePath: string,
  signal: AbortSignal,
  onProgress?: (offset: number, size: number) => void,
) {
  const name = remotePath.split('/').pop()!;
  const call = (data: object, signal: AbortSignal) =>
    api(`/hosts/${host}/files`, { ...data, projectId: project }, signal);
  const parts: BlobPart[] = [];
  const first = await call(
    { operation: 'read', path: remotePath, offset: 0 },
    signal,
  );
  const size = first.size as number;
  const version = first.version as string;
  let offset = 0;
  const append = (result: any, requested: number) => {
    const bytes = Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
    if (
      result.version !== version ||
      result.size !== size ||
      result.offset !== requested + bytes.length ||
      bytes.length !== Math.min(chunkSize, size - requested)
    )
      throw new Error('下载内容发生变化或不完整，请重试。');
    parts.push(bytes);
    offset = result.offset;
  };
  append(first, 0);
  while (offset < size) {
    onProgress?.(offset, size);
    const offsets = Array.from(
      { length: 4 },
      (_, i) => offset + i * chunkSize,
    ).filter((at) => at < size);
    const results = await Promise.allSettled(
      offsets.map((at) =>
        call(
          { operation: 'read', path: remotePath, offset: at, version },
          signal,
        ),
      ),
    );
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') throw result.reason;
      append(result.value, offsets[i]);
    }
    onProgress?.(offset, size);
  }
  signal.throwIfAborted();
  const url = URL.createObjectURL(
    new Blob(parts, { type: 'application/octet-stream' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  onProgress?.(offset, size);
}

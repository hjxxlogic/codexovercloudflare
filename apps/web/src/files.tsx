import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

type Entry = { name: string; directory: boolean; size: number };
const chunkSize = 64 * 1024;
function sizeLabel(size: number) {
  return size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KiB`
      : `${(size / 1024 / 1024).toFixed(1)} MiB`;
}
export function WorkspaceFiles({
  host,
  project,
}: {
  host: string;
  project: string;
}) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [writable, setWritable] = useState(false);
  const [limit, setLimit] = useState(20 * 1024 * 1024);
  const [loading, setLoading] = useState(false);
  const [file, setFile] = useState<File>();
  const [name, setName] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const listing = useRef(0);
  const transfer = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const uploadInput = useRef<HTMLInputElement>(null);
  const call = (data: unknown, signal?: AbortSignal) =>
    api(
      `/hosts/${host}/files`,
      { ...(data as object), projectId: project },
      signal,
    );
  async function load(append = false) {
    const request = ++listing.current;
    setLoading(true);
    setError('');
    try {
      const result = await call({
        operation: 'list',
        path,
        after: append ? next : '',
      });
      if (request !== listing.current || !mounted.current) return;
      setEntries((previous) =>
        append
          ? [
              ...previous,
              ...result.entries.filter(
                (entry: Entry) => !previous.some((p) => p.name === entry.name),
              ),
            ]
          : result.entries,
      );
      setNext(result.next);
      setWritable(result.writable);
      setLimit(result.maxSize);
    } catch (e) {
      if (request === listing.current && mounted.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (request === listing.current && mounted.current) setLoading(false);
    }
  }
  useEffect(() => {
    setEntries([]);
    setNext(null);
    void load();
    return () => {
      listing.current++;
    };
  }, [host, project, path]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      transfer.current?.abort();
    };
  }, []);
  function start() {
    const controller = new AbortController();
    transfer.current = controller;
    setBusy(true);
    setError('');
    return controller;
  }
  function finish(controller: AbortController, e?: unknown) {
    if (!mounted.current) return;
    if (e) {
      setError(
        controller.signal.aborted
          ? '传输已取消。'
          : e instanceof Error
            ? e.message
            : String(e),
      );
      setProgress('');
    }
    setBusy(false);
    transfer.current = null;
  }
  async function upload() {
    if (!file || !name.trim() || busy) return;
    if (file.size > limit) {
      setError(`文件超过 ${sizeLabel(limit)} 上限。`);
      return;
    }
    if (
      overwrite &&
      !confirm(`确认覆盖远程项目文件“${path ? path + '/' : ''}${name}”？`)
    )
      return;
    const controller = start();
    const uploadId = crypto.randomUUID();
    let committed = false;
    try {
      setProgress('正在准备上传…');
      await call(
        {
          operation: 'begin',
          uploadId,
          path: path ? `${path}/${name}` : name,
          size: file.size,
          overwrite,
        },
        controller.signal,
      );
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        const bytes = new Uint8Array(
          await file.slice(offset, offset + chunkSize).arrayBuffer(),
        );
        controller.signal.throwIfAborted();
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await call(
          { operation: 'chunk', uploadId, offset, data: btoa(binary) },
          controller.signal,
        );
        if (mounted.current)
          setProgress(
            `正在上传 ${Math.round((Math.min(offset + chunkSize, file.size) / file.size) * 100)}%`,
          );
      }
      await call({ operation: 'finish', uploadId }, controller.signal);
      committed = true;
      if (mounted.current) {
        setProgress(`已上传 ${name} · ${sizeLabel(file.size)}`);
        setFile(undefined);
        setName('');
        setOverwrite(false);
        if (uploadInput.current) uploadInput.current.value = '';
        void load();
      }
      finish(controller);
    } catch (e) {
      finish(controller, e);
    } finally {
      if (!committed)
        void call({ operation: 'cancel', uploadId }).catch(() => {});
    }
  }
  async function download(entry: Entry) {
    if (busy) return;
    const controller = start();
    try {
      const parts: BlobPart[] = [];
      let offset = 0,
        version: string | undefined;
      while (true) {
        setProgress(`正在下载 ${entry.name}…`);
        const result = await call(
          {
            operation: 'read',
            path: path ? `${path}/${entry.name}` : entry.name,
            offset,
            ...(version ? { version } : {}),
          },
          controller.signal,
        );
        const bytes = Uint8Array.from(atob(result.data), (c) =>
          c.charCodeAt(0),
        );
        parts.push(bytes);
        if (result.offset <= offset && result.offset < result.size)
          throw new Error('下载未能继续，请重试。');
        offset = result.offset;
        version = result.version;
        if (offset >= result.size) break;
      }
      controller.signal.throwIfAborted();
      const url = URL.createObjectURL(
        new Blob(parts, { type: 'application/octet-stream' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = entry.name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setProgress(`已下载 ${entry.name} · ${sizeLabel(offset)}`);
      finish(controller);
    } catch (e) {
      finish(controller, e);
    }
  }
  return (
    <section className="workspace-files" aria-label="工作区文件">
      <p className="file-context">
        远程项目：{project} · 单文件上限 {sizeLabel(limit)}
      </p>
      <div className="file-toolbar">
        <strong className="file-path">/{path}</strong>
        <button
          disabled={!path || busy || loading}
          onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}
        >
          上级目录
        </button>
        <button disabled={busy || loading} onClick={() => void load()}>
          刷新文件
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="file-list" aria-label="远程文件列表" aria-busy={loading}>
        {entries.map((entry) => (
          <div className="file-entry" key={entry.name}>
            {entry.directory ? (
              <button
                className="file-name"
                disabled={busy}
                onClick={() =>
                  setPath(path ? `${path}/${entry.name}` : entry.name)
                }
              >
                目录 · {entry.name}
              </button>
            ) : (
              <>
                <span className="file-name">
                  {entry.name}
                  <small>{sizeLabel(entry.size)}</small>
                </span>
                <button
                  disabled={busy || entry.size > limit}
                  onClick={() => void download(entry)}
                  aria-label={`下载 ${entry.name}`}
                >
                  下载
                </button>
              </>
            )}
          </div>
        ))}
        {loading && <p role="status">正在读取目录…</p>}
        {!loading && !entries.length && (
          <p className="empty-hint">当前目录没有可传输的文件。</p>
        )}
      </div>
      {next && (
        <button disabled={loading || busy} onClick={() => void load(true)}>
          加载更多文件
        </button>
      )}
      <form
        className="file-upload"
        onSubmit={(e) => {
          e.preventDefault();
          void upload();
        }}
      >
        <h3>上传到当前目录</h3>
        <label>
          选择文件
          <input
            type="file"
            ref={uploadInput}
            aria-label="选择上传文件"
            disabled={!writable || busy || loading}
            onChange={(e) => {
              const selected = e.currentTarget.files?.[0];
              setFile(selected);
              setName(selected?.name || '');
              setOverwrite(false);
            }}
          />
        </label>
        {file && (
          <>
            <label>
              保存为
              <input
                aria-label="远程文件名"
                required
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="overwrite-choice">
              <input
                type="checkbox"
                checked={overwrite}
                disabled={busy}
                onChange={(e) => setOverwrite(e.target.checked)}
              />
              覆盖已有文件
            </label>
          </>
        )}
        <button
          type="submit"
          disabled={!writable || !file || !name.trim() || busy || loading}
        >
          上传文件
        </button>
        {!loading && !writable && (
          <p>Agent 当前为只读模式，允许下载，禁止上传。</p>
        )}
      </form>
      {progress && (
        <p role="status" className="transfer-progress">
          {progress}
        </p>
      )}
      {busy && (
        <button onClick={() => transfer.current?.abort()}>取消传输</button>
      )}
      <p className="file-context">
        仅访问当前项目内的普通文件；不跟随符号链接。关闭面板会取消正在传输的文件，已完成的上传会保留。
      </p>
    </section>
  );
}

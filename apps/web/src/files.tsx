import { useEffect, useRef, useState } from 'react';
import type { HistoryCache } from './history.ts';
import { api, ApiError } from './api.ts';
import { downloadFile } from './download.ts';

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
  target,
  onBusy,
  cache,
}: {
  host: string;
  project: string;
  target?: string;
  onBusy?: (busy: boolean) => void;
  cache?: HistoryCache | null;
}) {
  const [path, setPath] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [writable, setWritable] = useState<boolean | undefined>();
  const [fraction, setFraction] = useState(0);
  const [unknownUpload, setUnknownUpload] = useState<string>();
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
    setWritable(undefined);
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
    void cache
      ?.record(`upload:${project}`)
      .then((id) => {
        if (mounted.current && id) setUnknownUpload(id);
      })
      .catch(() => {});
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
    onBusy?.(true);
    setFraction(0);
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
    onBusy?.(false);
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
      !confirm(
        `确认覆盖 ${target || project} 的远程项目文件“${path ? path + '/' : ''}${name}”？`,
      )
    )
      return;
    const controller = start();
    const uploadId = crypto.randomUUID();
    let committed = false;
    let publishing = false;
    try {
      setProgress('正在准备上传…');
      const begun = await call(
        {
          operation: 'begin',
          uploadId,
          path: path ? `${path}/${name}` : name,
          size: file.size,
          overwrite,
        },
        controller.signal,
      );
      const window = begun.window === 4 ? 4 : 1;
      for (let base = 0; base < file.size; base += chunkSize * window) {
        const offsets = Array.from(
          { length: window },
          (_, i) => base + i * chunkSize,
        ).filter((offset) => offset < file.size);
        // The Agent advertises a bounded reorder buffer. Older Agents stay sequential.
        const results = await Promise.allSettled(
          offsets.map(async (offset) => {
            const bytes = new Uint8Array(
              await file.slice(offset, offset + chunkSize).arrayBuffer(),
            );
            controller.signal.throwIfAborted();
            let binary = '';
            for (const byte of bytes) binary += String.fromCharCode(byte);
            return call(
              { operation: 'chunk', uploadId, offset, data: btoa(binary) },
              controller.signal,
            );
          }),
        );
        for (const result of results)
          if (result.status === 'rejected') throw result.reason;
        const sent = Math.min(base + chunkSize * window, file.size);
        if (mounted.current) {
          setFraction(sent / file.size);
          setProgress(
            `${name} · ${sizeLabel(sent)} / ${sizeLabel(file.size)} · 正在上传 ${Math.round((sent / file.size) * 100)}%`,
          );
        }
      }
      if (!cache) throw new Error('本机存储尚未就绪，暂不能提交文件');
      await cache.record(`upload:${project}`, uploadId);
      publishing = true;
      setProgress('正在确认文件提交…');
      await call({ operation: 'finish', uploadId }, controller.signal);
      committed = true;
      await cache.record(`upload:${project}`, null);
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
      if (
        publishing &&
        (!(e instanceof ApiError) || e.code === 'RESULT_UNKNOWN')
      ) {
        setUnknownUpload(uploadId);
        setProgress('文件提交结果待确认，请查询状态后核对远程文件。');
        finish(controller);
      } else finish(controller, e);
    } finally {
      if (!committed && !publishing)
        void call({ operation: 'cancel', uploadId }).catch(() => {});
    }
  }
  async function download(entry: Entry) {
    if (busy) return;
    const controller = start();
    try {
      await downloadFile(
        host,
        project,
        path ? `${path}/${entry.name}` : entry.name,
        controller.signal,
        (offset, size) => {
          setFraction(size ? offset / size : 1);
          setProgress(`正在下载 ${entry.name}…`);
        },
      );
      setProgress(`已交给浏览器下载 ${entry.name}`);
      finish(controller);
    } catch (e) {
      finish(controller, e);
    }
  }
  return (
    <section className="workspace-files" aria-label="工作区文件">
      <p className="file-context">
        远程项目：{target || project} · 单文件上限 {sizeLabel(limit)}
      </p>
      <div className="file-toolbar">
        <div className="file-path">
          <button disabled={busy} onClick={() => setPath('')}>
            项目根目录
          </button>
          {path
            .split('/')
            .filter(Boolean)
            .map((part, index, parts) => (
              <button
                key={index}
                disabled={busy}
                onClick={() => setPath(parts.slice(0, index + 1).join('/'))}
              >
                {' '}
                / {part}
              </button>
            ))}
        </div>
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
                  <small>
                    {sizeLabel(entry.size)}
                    {entry.size > limit ? ' · 超过单文件传输上限' : ''}
                  </small>
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
        {!loading && !error && !entries.length && (
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
        {!loading && writable === false && (
          <p>Agent 当前为只读模式，允许下载，禁止上传。</p>
        )}
      </form>
      {unknownUpload && (
        <button
          onClick={() =>
            void call({ operation: 'status', uploadId: unknownUpload })
              .then((result) => {
                if (result.state === 'completed') {
                  setProgress(`文件已提交 · SHA-256 ${result.sha256}`);
                  setUnknownUpload(undefined);
                  void cache?.record(`upload:${project}`, null);
                  void load();
                } else
                  setProgress('结果仍待核对；请检查远程文件，勿直接覆盖重传。');
              })
              .catch((error: Error) => setError(error.message))
          }
        >
          查询提交结果
        </button>
      )}
      {busy && <progress aria-label="文件传输进度" value={fraction} max={1} />}
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

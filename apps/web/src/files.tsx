import { IconButton } from './happier/icon-button.tsx';
import { t } from './i18n.ts';
import { useEffect, useRef, useState } from 'react';
import type { HistoryCache } from './history.ts';
import { api, queryApi } from './api.ts';
import { downloadFile } from './download.ts';
import { FileResource } from './file-links.tsx';
import type { OperationClient } from './operations.ts';
import { prepareUpload, resumeUpload, uploadRecords } from './uploads.ts';

type Entry = { name: string; directory: boolean; size: number };
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
  operations,
}: {
  host: string;
  project: string;
  target?: string;
  onBusy?: (busy: boolean) => void;
  cache?: HistoryCache | null;
  operations?: OperationClient | null;
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
    (['list', 'read', 'status'].includes(
      (data as { operation: string }).operation,
    )
      ? queryApi
      : api)(
      `/hosts/${host}/files`,
      { ...(data as object), projectId: project },
      signal,
    );
  async function load(append = false) {
    const request = ++listing.current;
    if (!host || !project) {
      setEntries([]);
      setNext(null);
      setWritable(false);
      setLoading(false);
      setError('');
      return;
    }
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
    setEntries([]);
    setNext(null);
    void load();
    return () => {
      listing.current++;
    };
  }, [host, project, path]);
  useEffect(() => {
    if (!cache || !operations) return;
    let disposed = false;
    void uploadRecords(cache)
      .then((records) => {
        const original = records.find(
          (record) =>
            record.host === host &&
            record.project === project &&
            record.phase !== 'completed' &&
            record.phase !== 'failed',
        );
        if (!disposed && original) {
          setUnknownUpload(original.id);
          void recoverUpload(original.id);
        }
      })
      .catch((error) => {
        if (!disposed) setError(String(error));
      });
    return () => {
      disposed = true;
    };
  }, [host, project, cache, operations]);
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
          ? '传输已暂停。'
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
        t(
          '确认覆盖 {0} 的远程项目文件“{1}{2}”？',
          target || project,
          path ? path + '/' : '',
          name,
        ),
      )
    )
      return;
    const controller = start();
    try {
      if (!cache || !operations)
        throw new Error('本机存储尚未就绪，暂不能提交文件');
      setProgress('正在保存原上传意图…');
      const id = await prepareUpload(
        cache,
        operations,
        file,
        {
          host,
          project,
          path: path ? `${path}/${name}` : name,
          overwrite,
        },
        controller.signal,
      );
      setUnknownUpload(id);
      await transferUpload(id, controller);
    } catch (error) {
      if (
        cache &&
        !(await uploadRecords(cache).catch(() => [])).some(
          (record) => record.phase !== 'completed' && record.phase !== 'failed',
        )
      )
        setUnknownUpload(undefined);
      finish(controller, error);
    }
  }
  async function transferUpload(id: string, controller: AbortController) {
    if (!cache || !operations) throw new Error('本机存储尚未就绪');
    const result = await resumeUpload(
      cache,
      operations,
      id,
      controller.signal,
      (offset, total) => {
        if (!mounted.current) return;
        setFraction(total ? offset / total : 1);
        setProgress(`${sizeLabel(offset)} / ${sizeLabel(total)} · 正在上传`);
      },
    );
    if (mounted.current) {
      setUnknownUpload(undefined);
      const original = (await uploadRecords(cache)).find(
        (record) => record.id === id,
      );
      setProgress(
        `已上传 ${original?.path.split('/').pop() || '文件'} · SHA-256 ${result?.sha256}`,
      );
      setFile(undefined);
      setName('');
      setOverwrite(false);
      if (uploadInput.current) uploadInput.current.value = '';
      void load();
    }
    finish(controller);
  }
  async function recoverUpload(id: string) {
    if (transfer.current || !cache || !operations || !mounted.current) return;
    const controller = start();
    try {
      await transferUpload(id, controller);
    } catch (error) {
      finish(controller, error);
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
    <section className="workspace-files" aria-label={t('工作区文件')}>
      <p className="file-context">
        {t('远程项目：')}
        {target || project} {t('· 单文件上限')} {sizeLabel(limit)}
      </p>
      <div className="file-toolbar">
        <div className="file-path">
          <IconButton
            icon="folder"
            label={t('项目根目录')}
            disabled={busy}
            onClick={() => setPath('')}
          />
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
        <IconButton
          icon="back"
          label={t('上级目录')}
          disabled={!path || busy || loading}
          onClick={() => setPath(path.split('/').slice(0, -1).join('/'))}
        />
        <IconButton
          icon="refresh"
          label={t('刷新文件')}
          disabled={busy || loading}
          onClick={() => void load()}
        />
      </div>
      {error && (
        <p role="alert" className="error">
          {t(error)}
        </p>
      )}
      <div
        className="file-list"
        aria-label={t('远程文件列表')}
        aria-busy={loading}
      >
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
                {t('目录 ·')} {entry.name}
              </button>
            ) : (
              <>
                <span className="file-name">
                  <FileResource
                    host={host}
                    project={project}
                    path={path ? `${path}/${entry.name}` : entry.name}
                    disabled={busy || entry.size > limit}
                  >
                    {entry.name}
                  </FileResource>
                  <small>
                    {sizeLabel(entry.size)}
                    {entry.size > limit ? t(' · 超过单文件传输上限') : ''}
                  </small>
                </span>
                <IconButton
                  icon="download"
                  label={t('下载 {0}', entry.name)}
                  disabled={busy || entry.size > limit}
                  onClick={() => void download(entry)}
                />
              </>
            )}
          </div>
        ))}
        {loading && <p role="status">{t('正在读取目录…')}</p>}
        {!loading && !error && !entries.length && (
          <p className="empty-hint">{t('当前目录没有可传输的文件。')}</p>
        )}
      </div>
      {next && (
        <IconButton
          icon="plus"
          label={t('加载更多文件')}
          disabled={loading || busy}
          onClick={() => void load(true)}
        />
      )}
      <form
        className="file-upload"
        onSubmit={(e) => {
          e.preventDefault();
          void upload();
        }}
      >
        <h3>{t('上传到当前目录')}</h3>
        <label>
          {t('选择文件')}
          <input
            type="file"
            ref={uploadInput}
            aria-label={t('选择上传文件')}
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
              {t('保存为')}
              <input
                aria-label={t('远程文件名')}
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
              {t('覆盖已有文件')}
            </label>
          </>
        )}
        <IconButton
          icon="upload"
          label={t('上传文件')}
          type="submit"
          disabled={!writable || !file || !name.trim() || busy || loading}
        />
        {!loading && writable === false && (
          <p>{t('Agent 当前为只读模式，允许下载，禁止上传。')}</p>
        )}
      </form>
      {unknownUpload && (
        <>
          <IconButton
            icon="history"
            label={t('恢复原上传')}
            disabled={busy}
            onClick={() => void recoverUpload(unknownUpload)}
          />
          <IconButton
            icon="info"
            label={t('查询提交结果')}
            onClick={() =>
              void uploadRecords(cache!)
                .then((records) => {
                  const original = records.find(
                    (record) => record.id === unknownUpload,
                  );
                  if (!original?.instance)
                    throw new Error('尚未取得上传实例，请恢复原上传');
                  return call({
                    operation: 'status',
                    uploadId: unknownUpload,
                    agentInstance: original.instance,
                  });
                })
                .then((result) => {
                  if (result.state === 'completed') {
                    setProgress(`文件已提交 · SHA-256 ${result.sha256}`);
                    void load();
                  } else
                    setProgress(
                      '结果仍待核对；请检查远程文件，勿直接覆盖重传。',
                    );
                })
                .catch((error: Error) => setError(error.message))
            }
          />
        </>
      )}
      {busy && (
        <progress aria-label={t('文件传输进度')} value={fraction} max={1} />
      )}
      {progress && (
        <p role="status" className="transfer-progress">
          {t(progress)}
        </p>
      )}
      {busy && (
        <IconButton
          icon="pause"
          label={t('暂停传输')}
          onClick={() => transfer.current?.abort()}
        />
      )}
      <p className="file-context">
        {t(
          '仅访问当前项目内的普通文件；不跟随符号链接。收起面板不取消传输；暂停后保留原上传，重新打开后恢复。',
        )}
      </p>
    </section>
  );
}

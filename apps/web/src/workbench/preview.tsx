import { useEffect, useRef, useState, type ReactNode } from 'react';
import { readFile, downloadFile } from '../download.ts';
import { fileType, filePreviewUrl } from '../file-types.ts';
import { MarkdownRenderer, Copy } from '../markdown/renderer.tsx';
import { t } from '../i18n.ts';
import { FullscreenButton } from './fullscreen.tsx';
export function Preview({
  host,
  project,
  path,
  close,
  reference,
  resize,
}: {
  resize: ReactNode;
  host: string;
  project: string;
  path: string;
  close: () => void;
  reference: (path: string) => void;
}) {
  const download = useRef<AbortController | null>(null);
  useEffect(() => () => download.current?.abort(), []);
  const [text, setText] = useState<string>();
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [retry, setRetry] = useState(0);
  const type = fileType(path);
  useEffect(() => {
    const controller = new AbortController();
    setText(undefined);
    setError('');
    if (!['text', 'markdown'].includes(type.kind)) {
      setError(t('此类型请下载查看'));
      return;
    }
    void readFile(
      host,
      project,
      path,
      controller.signal,
      undefined,
      1024 * 1024,
    )
      .then((blob) => blob.text())
      .then((value) => {
        if (!controller.signal.aborted) setText(value);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [host, project, path, type.kind, retry]);
  return (
    <section
      className="workbench-preview"
      data-pane="preview"
      aria-label={t('文件预览')}
    >
      {resize}
      <header className="pane-heading">
        <h2 title={path}>{path}</h2>
        <FullscreenButton pane="preview" />
        <button onClick={close} aria-label={t('关闭预览')}>
          {t('关闭')}
        </button>
      </header>
      <div className="row">
        <Copy value={path} />
        <button onClick={() => reference(path)}>{t('引用到对话')}</button>
        <a
          href={filePreviewUrl(host, project, path)}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t('新窗口')}
        </a>
        <button
          onClick={() => {
            download.current?.abort();
            const controller = new AbortController();
            download.current = controller;
            void downloadFile(host, project, path, controller.signal).catch(
              (e: unknown) => {
                if (!controller.signal.aborted) setError(String(e));
              },
            );
          }}
        >
          {t('下载')}
        </button>
      </div>
      <input
        aria-label={t('本文件查找')}
        placeholder={t('本文件查找')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error ? (
        <p role="alert">
          {error}
          <button onClick={() => setRetry(retry + 1)}>{t('重试')}</button>
        </p>
      ) : text === undefined ? (
        <p role="status">{t('正在读取…')}</p>
      ) : query ? (
        <pre className="file-lines">
          {text.split('\n').map((line, i) =>
            line.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? (
              <span key={i}>
                <small>{i + 1}</small> {line}
                {'\n'}
              </span>
            ) : null,
          )}
        </pre>
      ) : type.kind === 'markdown' ? (
        <article className="markdown">
          <MarkdownRenderer text={text} tools />
        </article>
      ) : (
        <pre className="file-lines">
          {text.split('\n').map((line, i) => (
            <span key={i}>
              <small>{i + 1}</small> {line}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
    </section>
  );
}

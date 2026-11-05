import { IconButton, IconLink } from '../happier/icon-button.tsx';
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
      <div className="pane-controls">
        <header className="pane-heading">
          <h2 title={path}>{path}</h2>
          <FullscreenButton pane="preview" />
          <IconButton icon="close" label={t('关闭预览')} onClick={close} />
        </header>
        <div className="row">
          <Copy value={path} />
          <IconButton
            icon="link"
            label={t('引用到对话')}
            onClick={() => reference(path)}
          />
          <IconLink
            icon="external"
            label={t('新窗口')}
            href={filePreviewUrl(host, project, path)}
            target="_blank"
            rel="noopener noreferrer"
          />

          <IconButton
            icon="download"
            label={t('下载')}
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
          />
        </div>
        <input
          aria-label={t('本文件查找')}
          placeholder={t('本文件查找')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {error ? (
        <p role="alert">
          {error}
          <IconButton
            icon="refresh"
            label={t('重试')}
            onClick={() => setRetry(retry + 1)}
          />
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

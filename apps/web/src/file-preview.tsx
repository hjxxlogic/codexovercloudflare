import { useEffect, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { api, setEmailAccount } from './api.ts';
import { readFile, saveFile } from './download.ts';
import { fileType } from './file-types.ts';
import { t, useLanguage } from './i18n.ts';

export function FilePreview() {
  useLanguage();
  const params = new URLSearchParams(location.hash.slice(1));
  const host = params.get('host') || '',
    project = params.get('project') || '',
    path = params.get('path') || '';
  const [file, setFile] = useState<Blob>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setFile(undefined);
    setText('');
    setError('');
    document.title = path.split('/').pop() || t('文件预览');
    void (async () => {
      if (
        !host ||
        !project ||
        !path ||
        !['markdown', 'text'].includes(fileType(path).kind)
      )
        throw new Error(t('无法预览此文件'));
      const identity = await api('/auth/email', undefined, controller.signal);
      if (identity.enabled) setEmailAccount(identity.accountId || '');
      const blob = await readFile(host, project, path, controller.signal);
      const content = await blob.text();
      controller.signal.throwIfAborted();
      setFile(blob);
      setText(content);
    })().catch((e) => {
      if (!controller.signal.aborted)
        setError(e instanceof Error ? e.message : String(e));
    });
    return () => controller.abort();
  }, [host, project, path, retry]);
  return (
    <main className="file-preview-page">
      <header className="file-preview-toolbar">
        <h1>{path || t('文件预览')}</h1>
        <button
          disabled={!file}
          onClick={() => file && saveFile(file, path.split('/').pop()!)}
        >
          {t('下载')}
        </button>
      </header>
      {error ? (
        <div role="alert">
          <p>{t(error)}</p>
          <button onClick={() => setRetry((n) => n + 1)}>{t('重试')}</button>
        </div>
      ) : !file ? (
        <p role="status">{t('正在读取…')}</p>
      ) : fileType(path).kind === 'markdown' ? (
        <article className="markdown file-preview-document">
          <Markdown
            remarkPlugins={[remarkGfm]}
            skipHtml
            components={{
              a: ({ href, children }) =>
                href && /^(https?:|mailto:)/i.test(href) ? (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ) : (
                  <span>{children}</span>
                ),
              img: ({ alt }) => <span>{alt}</span>,
            }}
          >
            {text}
          </Markdown>
        </article>
      ) : (
        <pre className="file-preview-text">{text}</pre>
      )}
    </main>
  );
}

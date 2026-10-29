import { t } from './i18n.ts';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { downloadFile, readFile, saveFile } from './download.ts';
import { fileType, filePreviewUrl } from './file-types.ts';

export const FileContext = createContext<{
  host: string;
  project: string;
  root: string;
} | null>(null);

const LinkLabelContext = createContext(false);

// Strip editor line references, but never turn a URL or an escaping path into a download.
export function projectFilePath(value: string, root: string): string | null {
  let path = value.trim();
  const windows = /^[a-z]:[\\/]/i.test(root);
  const fileUri = path.startsWith('file:///');
  if (path.startsWith('file://')) {
    if (!path.startsWith('file:///')) return null;
    path = path.slice(7);
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  path = path.replace(
    /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/,
    '',
  );
  if (windows) {
    if (fileUri && /^\/[a-z]:\//i.test(path)) path = path.slice(1);
    if (/^(?:\\\\|\/\/)/.test(path)) return null;
    path = path.replace(/\\/g, '/');
    root = root.replace(/\\/g, '/');
    if (/^[a-z]:\//i.test(path)) {
      const prefix = root.replace(/\/+$/, '') + '/';
      if (!path.toLowerCase().startsWith(prefix.toLowerCase())) return null;
      path = path.slice(prefix.length);
    }
    if (path.startsWith('/') || path.includes(':')) return null;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(path)) return null;
  if (
    !path ||
    /[\\?#]/.test(path) ||
    Array.from(path).some((c) => c.charCodeAt(0) < 32) ||
    path.endsWith('/')
  )
    return null;
  if (path.startsWith('/')) {
    const prefix = root.replace(/\/+$/, '') + '/';
    if (!root.startsWith('/') || !path.startsWith(prefix)) return null;
    path = path.slice(prefix.length);
  }
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else if (part && part !== '.') parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}

// Plain prose needs a path separator or filename extension; explicit links can use any filename.
export function fileReferences(text: string) {
  const pattern =
    /^(?:file:\/\/\/|[a-z]:[\\/]|\.{0,2}[\\/]|[\p{L}\p{N}_@-]+[\\/])[^\s<>"'`，。；！？（）【】]+|^[\p{L}\p{N}_@-]+(?:\.[\p{L}\p{N}_-]+)+(?:，|。)?(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?/giu;
  // Skip prose tokens without separators before matching filenames. This keeps long
  // streamed paragraphs from causing quadratic regexp backtracking.
  return Array.from(
    text.matchAll(/[^\s<>"'`，。；！？（）【】()[\]{}]+/gu),
  ).flatMap((token) => {
    if (!token[0].includes('/') && !token[0].includes('.')) return [];
    return Array.from(token[0].matchAll(pattern))
      .filter(
        (match) =>
          !match.index ||
          !/[\p{L}\p{N}_:/\\.]/u.test(token[0][match.index - 1]),
      )
      .map((match) => ({
        index: token.index + match.index,
        text: match[0].replace(/[.,;!?)\]}，。]+$/, ''),
      }));
  });
}

type Node = { type: string; value?: string; url?: string; children?: Node[] };
export function remarkFileLinks() {
  return (tree: Node) => {
    function visit(node: Node) {
      if (
        [
          'link',
          'linkReference',
          'code',
          'html',
          'image',
          'imageReference',
        ].includes(node.type)
      )
        return;
      if (!node.children) return;
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text') {
          const value = child.value || '';
          const result: Node[] = [];
          let offset = 0;
          for (const match of fileReferences(value)) {
            result.push({
              type: 'text',
              value: value.slice(offset, match.index),
            });
            result.push({
              type: 'link',
              url: match.text,
              children: [{ type: 'text', value: match.text }],
            });
            offset = match.index + match.text.length;
          }
          result.push({ type: 'text', value: value.slice(offset) });
          return result;
        }
        visit(child);
        return [child];
      });
    }
    visit(tree);
  };
}

export function FileLink({
  href,
  children,
}: {
  href?: string;
  children: ReactNode;
}) {
  const label = (
    <LinkLabelContext.Provider value={true}>
      {children}
    </LinkLabelContext.Provider>
  );
  const context = useContext(FileContext);
  const path = context && href ? projectFilePath(href, context.root) : null;
  if (!context || !path) {
    // Local paths outside the project remain visible without navigating away.
    return href && /^(https?:|mailto:)/i.test(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {label}
      </a>
    ) : (
      <span>{label}</span>
    );
  }
  return (
    <FileResource host={context.host} project={context.project} path={path}>
      {label}
    </FileResource>
  );
}

export function FileResource({
  host,
  project,
  path,
  children,
  disabled = false,
}: {
  host: string;
  project: string;
  path: string;
  children: ReactNode;
  disabled?: boolean;
}) {
  const type = fileType(path);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [media, setMedia] = useState<{ url: string; blob: Blob }>();
  const [expanded, setExpanded] = useState(false);
  const transfer = useRef<AbortController | null>(null);
  useEffect(() => {
    transfer.current = null;
    setStatus('');
    setBusy(false);
    setExpanded(false);
    setMedia(undefined);
    return () => {
      transfer.current?.abort();
    };
  }, [host, project, path]);
  useEffect(
    () => () => {
      if (media) URL.revokeObjectURL(media.url);
    },
    [media],
  );
  const text = type.kind === 'text' || type.kind === 'markdown';
  const downloadable = type.kind === 'download';
  const action = text
    ? '预览 {0}'
    : downloadable
      ? '下载 {0}'
      : expanded
        ? '收起 {0}'
        : '展开 {0}';
  return (
    <>
      <a
        href={text ? filePreviewUrl(host, project, path) : '#'}
        target={text ? '_blank' : undefined}
        rel={text ? 'noopener noreferrer' : undefined}
        title={t(action, path)}
        aria-label={t(action, path)}
        aria-disabled={disabled || busy}
        onClick={(event) => {
          if (disabled || busy) {
            event.preventDefault();
            return;
          }
          if (text) return;
          event.preventDefault();
          if (!downloadable && media) {
            setExpanded((v) => !v);
            return;
          }
          if (transfer.current) return;
          const controller = new AbortController();
          transfer.current = controller;
          setBusy(true);
          setStatus(downloadable ? '正在下载…' : '正在读取…');
          const work = downloadable
            ? downloadFile(host, project, path, controller.signal)
            : readFile(host, project, path, controller.signal).then((blob) => {
                controller.signal.throwIfAborted();
                setMedia({
                  url: URL.createObjectURL(blob.slice(0, blob.size, type.mime)),
                  blob,
                });
                setExpanded(true);
              });
          void work
            .then(() => {
              if (!controller.signal.aborted)
                setStatus(downloadable ? '已交给浏览器下载' : '');
            })
            .catch((error: unknown) => {
              if (!controller.signal.aborted)
                setStatus(
                  `读取失败：${error instanceof Error ? error.message : String(error)}`,
                );
            })
            .finally(() => {
              if (transfer.current === controller) transfer.current = null;
              if (!controller.signal.aborted) setBusy(false);
            });
        }}
      >
        {children}
      </a>
      {status && (
        <small className="file-link-status" role="status">
          {' '}
          {t(status)}
        </small>
      )}
      {expanded && media && (
        <span className="file-media" aria-label={t('预览 {0}', path)}>
          {type.kind === 'image' ? (
            <img
              src={media.url}
              alt={path}
              onError={() => setStatus('浏览器无法显示此文件，请下载查看。')}
            />
          ) : type.kind === 'audio' ? (
            <audio
              src={media.url}
              controls
              preload="metadata"
              onError={() => setStatus('浏览器不支持此媒体格式，请下载查看。')}
            />
          ) : (
            <video
              src={media.url}
              controls
              playsInline
              preload="metadata"
              onError={() => setStatus('浏览器不支持此媒体格式，请下载查看。')}
            />
          )}
          <button
            type="button"
            onClick={() => saveFile(media.blob, path.split('/').pop()!)}
          >
            {t('下载')}
          </button>
        </span>
      )}
    </>
  );
}

export function FileText({ text }: { text: string }) {
  const inLink = useContext(LinkLabelContext);
  if (inLink) return <>{text}</>;
  const nodes: ReactNode[] = [];
  let offset = 0;
  for (const match of fileReferences(text)) {
    nodes.push(text.slice(offset, match.index));
    nodes.push(
      <FileLink key={match.index} href={match.text}>
        {match.text}
      </FileLink>,
    );
    offset = match.index + match.text.length;
  }
  nodes.push(text.slice(offset));
  return <>{nodes}</>;
}

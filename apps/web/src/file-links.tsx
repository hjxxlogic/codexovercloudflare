import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { downloadFile } from './download.ts';

export const FileContext = createContext<{
  host: string;
  project: string;
  root: string;
} | null>(null);

const LinkLabelContext = createContext(false);

// Strip editor line references, but never turn a URL or an escaping path into a download.
export function projectFilePath(value: string, root: string): string | null {
  let path = value.trim();
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
    /^(?:file:\/\/\/|\.{0,2}\/|[\p{L}\p{N}_@-]+\/)[^\s<>"'`，。；！？（）【】]+|^[\p{L}\p{N}_@-]+(?:\.[\p{L}\p{N}_-]+)+(?:，|。)?(?::\d+(?::\d+)?|#L\d+(?:C\d+)?)?/gu;
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
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const transfer = useRef<AbortController | null>(null);
  useEffect(() => {
    transfer.current = null;
    setStatus('');
    setBusy(false);
    return () => transfer.current?.abort();
  }, [context?.host, context?.project, path]);
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
    <>
      <a
        href={href}
        title={`下载 ${path}`}
        aria-label={`下载 ${path}`}
        aria-disabled={busy}
        onClick={(event) => {
          event.preventDefault();
          if (transfer.current) return;
          const controller = new AbortController();
          transfer.current = controller;
          setBusy(true);
          setStatus('正在下载…');
          void downloadFile(
            context.host,
            context.project,
            path,
            controller.signal,
          )
            .then(() => {
              if (!controller.signal.aborted) setStatus('已交给浏览器下载');
            })
            .catch((error: unknown) => {
              if (!controller.signal.aborted)
                setStatus(
                  `下载失败：${error instanceof Error ? error.message : String(error)}`,
                );
            })
            .finally(() => {
              if (transfer.current === controller) transfer.current = null;
              if (!controller.signal.aborted) setBusy(false);
            });
        }}
      >
        {label}
      </a>
      {status && (
        <small className="file-link-status" role="status">
          {' '}
          {status}
        </small>
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

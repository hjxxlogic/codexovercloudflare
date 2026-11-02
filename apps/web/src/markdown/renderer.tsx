import {
  Children,
  isValidElement,
  lazy,
  Suspense,
  useContext,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import {
  FileContext,
  FileLink,
  FileText,
  projectFilePath,
  remarkFileLinks,
} from '../file-links.tsx';
import { t } from '../i18n.ts';
import { saveFile } from '../download.ts';
import { remarkStructure, remarkInlineMath } from './structure.ts';
const RichBlock = lazy(() => import('./rich-block.tsx'));
export function textOf(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textOf(child.props.children)
          : '',
    )
    .join('');
}
export function Copy({ value }: { value: string }) {
  const [status, setStatus] = useState('');
  return (
    <>
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => setStatus(t('已复制')))
            .catch(() => setStatus(t('请手动选择文本复制')))
        }
      >
        {t('复制')}
      </button>
      <small role="status">{status}</small>
    </>
  );
}
function InlineMath({ source }: { source: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="inline-math">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <code>{source}</code> {t('公式')}
      </button>
      {open && (
        <Suspense fallback={source}>
          <RichBlock source={source} kind="inline-math" />
        </Suspense>
      )}
    </span>
  );
}
function Table({ children }: { children: ReactNode }) {
  const root = useRef<HTMLTableElement>(null);
  const [status, setStatus] = useState('');
  async function copy() {
    const value = Array.from(root.current?.rows || [], (row) =>
      Array.from(
        row.cells,
        (cell) => cell.textContent?.replace(/[\t\r\n]+/g, ' ') || '',
      ).join('\t'),
    ).join('\n');
    try {
      await navigator.clipboard.writeText(value);
      setStatus(t('已复制'));
    } catch {
      setStatus(t('请手动选择文本复制'));
    }
  }
  return (
    <div className="table-scroll">
      <button type="button" onClick={() => void copy()}>
        {t('复制表格 TSV')}
      </button>
      <small role="status">{status}</small>
      <table ref={root}>{children}</table>
    </div>
  );
}
function CodeBlock({ source, language }: { source: string; language: string }) {
  const [wrap, setWrap] = useState(false);
  const [preview, setPreview] = useState(false);
  const [highlight, setHighlight] = useState('');
  const special = language === 'mermaid' || language === 'math';
  async function colorize() {
    if (source.length > 100000) return;
    const [{ default: hljs }, { default: sanitize }] = await Promise.all([
      import('highlight.js/lib/common'),
      import('dompurify'),
    ]);
    if (hljs.getLanguage(language))
      setHighlight(
        sanitize.sanitize(
          hljs.highlight(source, { language, ignoreIllegals: true }).value,
        ),
      );
  }
  return (
    <div className="code-block rich-code">
      <div className="code-toolbar">
        <span>{language || 'text'}</span>
        <Copy value={source} />
        <button
          type="button"
          onClick={() =>
            saveFile(
              new Blob([source], { type: 'text/plain;charset=utf-8' }),
              `code.${language === 'mermaid' ? 'mmd' : 'txt'}`,
            )
          }
        >
          {t('下载源码')}
        </button>
        <button
          type="button"
          onClick={() => setWrap(!wrap)}
          aria-pressed={wrap}
        >
          {t('折行')}
        </button>
        {special ? (
          <button
            type="button"
            onClick={() => setPreview(!preview)}
            aria-pressed={preview}
          >
            {preview ? t('源码') : t('格式化预览')}
          </button>
        ) : (
          language && (
            <button type="button" onClick={() => void colorize()}>
              {t('语法高亮')}
            </button>
          )
        )}
      </div>
      {preview && special ? (
        <Suspense fallback={<pre>{source}</pre>}>
          <RichBlock source={source} kind={language} />
        </Suspense>
      ) : (
        <pre className={wrap ? 'code-wrap' : ''}>
          {highlight ? (
            <code dangerouslySetInnerHTML={{ __html: highlight }} />
          ) : (
            <code>
              <FileText text={source} />
            </code>
          )}
        </pre>
      )}
    </div>
  );
}
export function MarkdownRenderer({
  text,
  scope: suppliedScope,
}: {
  text: string;
  scope?: string;
}) {
  const generated = useId().replace(/[^a-z0-9]/gi, '');
  const scope = suppliedScope || `md-${generated}`;
  const context = useContext(FileContext);
  const root = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState(false);
  const [toc, setToc] = useState(false);
  const [headings, setHeadings] = useState<{ title: string; id: string }[]>([]);
  return (
    <div className="formatted-document" ref={root}>
      <div className="document-tools">
        <button
          type="button"
          onClick={() => setSource(!source)}
          aria-pressed={source}
        >
          {source ? t('格式化预览') : t('源码')}
        </button>
        <button
          type="button"
          onClick={() => {
            setHeadings(
              Array.from(
                root.current?.querySelectorAll<HTMLElement>(
                  `[id^="${scope}-heading-"]`,
                ) || [],
              ).map((node) => ({ title: node.textContent || '', id: node.id })),
            );
            setToc(!toc);
          }}
          aria-expanded={toc}
        >
          {t('目录')}
        </button>
        <Copy value={text} />
      </div>
      {source ? (
        <pre className="source-view">{text}</pre>
      ) : (
        <Markdown
          remarkPlugins={[
            remarkGfm,
            [remarkMath, { singleDollarTextMath: false }],
            [remarkStructure, { scope }],
            remarkInlineMath,
            ...(context ? [remarkFileLinks] : []),
          ]}
          skipHtml
          remarkRehypeOptions={{ clobberPrefix: `${scope}-` }}
          urlTransform={(url) =>
            context && projectFilePath(url, context.root)
              ? url
              : defaultUrlTransform(url)
          }
          components={{
            pre: ({ children }) => {
              const child = Children.toArray(children)[0];
              const language = isValidElement<{ className?: string }>(child)
                ? child.props.className?.match(/language-([^\s]+)/)?.[1] || ''
                : '';
              return (
                <CodeBlock
                  key={textOf(children)}
                  source={textOf(children)}
                  language={language}
                />
              );
            },
            code: ({ children, className }) =>
              className?.includes('math-inline') ? (
                <InlineMath source={textOf(children)} />
              ) : (
                <code className={className}>
                  <FileText text={textOf(children)} />
                </code>
              ),
            a: ({ href, children, node: _node, ...props }) =>
              href?.startsWith('#') ? (
                <a
                  {...props}
                  href={href}
                  onClick={(event) => {
                    event.preventDefault();
                    const target = root.current?.querySelector(
                      `[id="${CSS.escape(href.slice(1))}"]`,
                    );
                    target?.scrollIntoView({ block: 'nearest' });
                    if (target instanceof HTMLElement) {
                      target.tabIndex = -1;
                      target.focus({ preventScroll: true });
                    }
                  }}
                >
                  {children}
                </a>
              ) : (
                <FileLink href={href}>{children}</FileLink>
              ),
            img: ({ alt, src }) => (
              <FileLink href={typeof src === 'string' ? src : undefined}>
                {alt || t('图片')}
              </FileLink>
            ),
            table: ({ children }) => <Table>{children}</Table>,
          }}
        >
          {text}
        </Markdown>
      )}
      {toc && !source && (
        <nav className="document-toc" aria-label={t('目录')}>
          {headings.length ? (
            headings.map((h) => (
              <button
                type="button"
                key={h.id}
                onClick={() =>
                  root.current
                    ?.querySelector(`[id="${h.id}"]`)
                    ?.scrollIntoView({ block: 'nearest' })
                }
              >
                {h.title}
              </button>
            ))
          ) : (
            <small>{t('没有标题')}</small>
          )}
        </nav>
      )}
    </div>
  );
}

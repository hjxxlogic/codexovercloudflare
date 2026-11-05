import {
  Children,
  isValidElement,
  lazy,
  Suspense,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import Markdown, { defaultUrlTransform, type Components } from 'react-markdown';
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
import { Icon } from '../happier/icon.tsx';
import { saveFile } from '../download.ts';
import { remarkStructure, remarkInlineMath } from './structure.ts';
import { remarkOpenAiMath } from './openai-math.ts';
import {
  ElementFullscreenButton,
  useElementFullscreen,
} from '../fullscreen.tsx';
import { useContentOverflow } from './overflow.ts';
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
        aria-label={t('复制')}
        title={t('复制')}
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => setStatus(t('已复制')))
            .catch(() => setStatus(t('请手动选择文本复制')))
        }
      >
        <Icon name="copy" size={15} />
      </button>
      <small role="status">{status}</small>
    </>
  );
}
function AutoRich({
  source,
  kind,
  expanded = false,
  overflow,
}: {
  source: string;
  kind: 'mermaid' | 'math' | 'inline-math';
  expanded?: boolean;
  overflow?: (value: boolean) => void;
}) {
  const target = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    if (target.current) observer.observe(target.current);
    return () => observer.disconnect();
  }, []);
  return (
    <span ref={target} className="auto-rich">
      {visible ? (
        <Suspense fallback={<code>{source}</code>}>
          <RichBlock
            source={source}
            kind={kind}
            expanded={expanded}
            onOverflow={overflow}
          />
        </Suspense>
      ) : (
        <code>{source}</code>
      )}
    </span>
  );
}
function InlineMath({
  source,
  display = false,
}: {
  source: string;
  display?: boolean;
}) {
  const fullscreen = useElementFullscreen<HTMLSpanElement>();
  const content = useRef<HTMLSpanElement>(null);
  const overflow = useContentOverflow(content, fullscreen.active);
  return (
    <span
      ref={fullscreen.ref}
      className={`${display ? 'display-math' : 'inline-math'}${fullscreen.active ? ' element-fullscreen' : ''}`}
    >
      {(fullscreen.active || overflow) && (
        <span className="element-toolbar">
          <ElementFullscreenButton
            active={fullscreen.active}
            toggle={fullscreen.toggle}
          />
        </span>
      )}
      <span ref={content} className="math-content">
        <AutoRich source={source} kind={display ? 'math' : 'inline-math'} />
      </span>
    </span>
  );
}
function Table({ children }: { children: ReactNode }) {
  const fullscreen = useElementFullscreen<HTMLDivElement>();
  const root = useRef<HTMLTableElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const overflow = useContentOverflow(content, fullscreen.active);
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
    <div
      ref={fullscreen.ref}
      className={`table-scroll${fullscreen.active ? ' element-fullscreen' : ''}`}
    >
      <div className="element-toolbar">
        <span>{t('表格')}</span>
        <button
          type="button"
          aria-label={t('复制表格 TSV')}
          title={t('复制表格 TSV')}
          onClick={() => void copy()}
        >
          <Icon name="copy" size={15} />
        </button>
        <small role="status">{status}</small>
        {(fullscreen.active || overflow) && (
          <ElementFullscreenButton
            active={fullscreen.active}
            toggle={fullscreen.toggle}
          />
        )}
      </div>
      <div ref={content} className="table-content">
        <table ref={root}>{children}</table>
      </div>
    </div>
  );
}
function CodeBlock({ source, language }: { source: string; language: string }) {
  const fullscreen = useElementFullscreen<HTMLDivElement>();
  const [wrap, setWrap] = useState(false);
  const content = useRef<HTMLDivElement>(null);
  const overflow = useContentOverflow(content, fullscreen.active);
  const [diagramOverflow, setDiagramOverflow] = useState(false);
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
    <div
      ref={fullscreen.ref}
      data-language={language || 'text'}
      className={`code-block rich-code${special ? ' rendered-code' : ''}${fullscreen.active ? ' element-fullscreen' : ''}`}
    >
      {(!special || fullscreen.active || overflow || diagramOverflow) && (
        <div className="code-toolbar">
          {!special && <span>{language || 'text'}</span>}
          {(fullscreen.active || overflow || diagramOverflow) && (
            <ElementFullscreenButton
              active={fullscreen.active}
              toggle={fullscreen.toggle}
            />
          )}
          {!special && (
            <>
              <Copy value={source} />
              <button
                type="button"
                aria-label={t('下载源码')}
                title={t('下载源码')}
                onClick={() =>
                  saveFile(
                    new Blob([source], { type: 'text/plain;charset=utf-8' }),
                    `code.${language === 'mermaid' ? 'mmd' : 'txt'}`,
                  )
                }
              >
                <Icon name="download" size={15} />
              </button>
              <button
                type="button"
                onClick={() => setWrap(!wrap)}
                aria-label={t('折行')}
                title={t('折行')}
                aria-pressed={wrap}
              >
                <Icon name="wrap" size={15} />
              </button>
              {language && (
                <button
                  type="button"
                  aria-label={t('语法高亮')}
                  title={t('语法高亮')}
                  onClick={() => void colorize()}
                >
                  <Icon name="code" size={15} />
                </button>
              )}
            </>
          )}
        </div>
      )}
      <div ref={content} className="element-content">
        {special ? (
          <AutoRich
            source={source}
            kind={language}
            expanded={fullscreen.active}
            overflow={setDiagramOverflow}
          />
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
    </div>
  );
}
export function MarkdownRenderer({
  text,
  scope: suppliedScope,
  tools = false,
}: {
  text: string;
  scope?: string;
  tools?: boolean;
}) {
  const generated = useId().replace(/[^a-z0-9]/gi, '');
  const scope = suppliedScope || `md-${generated}`;
  const context = useContext(FileContext);
  const root = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState(false);
  const [toc, setToc] = useState(false);
  const [headings, setHeadings] = useState<{ title: string; id: string }[]>([]);
  // Stable renderer types preserve open previews across Workbench/theme renders.
  const components = useMemo<Components>(
    () => ({
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
        className?.includes('math-inline') ||
        className?.includes('math-display') ? (
          <InlineMath
            source={textOf(children)}
            display={className.includes('math-display')}
          />
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
    }),
    [],
  );

  return (
    <div className="formatted-document" ref={root}>
      {tools && (
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
                ).map((node) => ({
                  title: node.textContent || '',
                  id: node.id,
                })),
              );
              setToc(!toc);
            }}
            aria-expanded={toc}
          >
            {t('目录')}
          </button>
          <Copy value={text} />
        </div>
      )}
      {source ? (
        <pre className="source-view">{text}</pre>
      ) : (
        <Markdown
          remarkPlugins={[
            remarkGfm,
            [remarkMath, { singleDollarTextMath: false }],
            remarkOpenAiMath,
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
          components={components}
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

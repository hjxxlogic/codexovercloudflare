import { useEffect, useRef, useState } from 'react';
import { relayPath } from '../routes.ts';
import { t, localeTag } from '../i18n.ts';
import { useResolvedTheme } from '../theme.ts';
import { exitTopFullscreen } from '../fullscreen.tsx';

// Visible blocks render automatically; debounce partial streaming source.
export default function RichBlock({
  source,
  kind,
  expanded = false,
  onOverflow,
}: {
  source: string;
  kind: 'mermaid' | 'math' | 'inline-math';
  expanded?: boolean;
  onOverflow?: (value: boolean) => void;
}) {
  const theme = useResolvedTheme();
  const language = localeTag();
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [height, setHeight] = useState(96);
  const overflow = useRef(onOverflow);
  overflow.current = onOverflow;
  const frame = useRef<HTMLIFrameElement>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { type: 'cw-diagram-layout', expanded, language },
      '*',
    );
  }, [expanded, language]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'cw-fullscreen-escape') {
        if (frame.current) exitTopFullscreen(frame.current);
        return;
      }
      if (event.data?.type === 'cw-diagram-size') {
        const { width, renderedHeight } = event.data;
        if (
          ![width, renderedHeight].every(
            (value) =>
              typeof value === 'number' &&
              Number.isFinite(value) &&
              value > 0 &&
              value <= 1e7,
          )
        )
          return;
        setHeight(Math.min(480, Math.max(64, Math.ceil(renderedHeight + 24))));
        overflow.current?.(
          width > (frame.current?.clientWidth || 0) - 24 + 1 ||
            renderedHeight + 24 > 481,
        );
        return;
      }
      if (event.data?.type !== 'cw-diagram-result') return;
      clearTimeout(deadline.current);
      if (event.data.error) setError(t('图表无法渲染，已显示源码'));
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      clearTimeout(deadline.current);
    };
  }, [source, kind, theme]);
  useEffect(() => {
    let active = true;
    setResult('');
    setError('');
    overflow.current?.(false);
    const timer = setTimeout(() => {
      void (async () => {
        if (
          new TextEncoder().encode(source).byteLength >
          (kind === 'mermaid' ? 32768 : 16384)
        )
          throw new Error(t('内容超过预览上限'));
        if (kind === 'mermaid') {
          if (active) setResult('diagram');
        } else {
          const [{ default: katex }, { default: sanitize }] = await Promise.all(
            [import('katex'), import('dompurify')],
          );
          await import('katex/dist/katex.min.css');
          const html = katex.renderToString(source, {
            displayMode: kind === 'math',
            trust: false,
            strict: 'error',
            throwOnError: true,
            maxExpand: 100,
            maxSize: 20,
            output: 'htmlAndMathml',
          });
          if (active) setResult(sanitize.sanitize(html));
        }
      })().catch((e: unknown) => {
        if (active) setError(e instanceof Error ? e.message : String(e));
      });
    }, 120);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [source, kind, theme]);
  if (error)
    return (
      <span className="rich-fallback">
        <small role="status">{error}</small>
        {'\n'}
        <code>{source}</code>
      </span>
    );
  if (!result) return <span role="status">{t('正在读取…')}</span>;
  if (kind === 'mermaid')
    return (
      <iframe
        key={JSON.stringify([source, theme])}
        ref={frame}
        title={t('Mermaid 图表')}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        src={relayPath('/diagram')}
        style={expanded ? undefined : { height }}
        onLoad={() => {
          clearTimeout(deadline.current);
          deadline.current = setTimeout(
            () => setError(t('图表无法渲染，已显示源码')),
            2000,
          );
          frame.current?.contentWindow?.postMessage(
            { type: 'cw-diagram', source, theme, expanded, language },
            '*',
          );
        }}
        onError={() => setError(t('图表无法渲染，已显示源码'))}
        className="diagram-frame"
      />
    );
  return (
    <span
      className="math-result"
      dangerouslySetInnerHTML={{ __html: result }}
    />
  );
}

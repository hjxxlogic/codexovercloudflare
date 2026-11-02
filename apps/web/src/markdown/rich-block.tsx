import { useEffect, useRef, useState } from 'react';
import { relayPath } from '../routes.ts';
import { t } from '../i18n.ts';
import { useResolvedTheme } from '../theme.ts';
import { exitTopFullscreen } from '../fullscreen.tsx';

// Expensive engines are loaded only after a user explicitly opens a block.
export default function RichBlock({
  source,
  kind,
  expanded = false,
}: {
  source: string;
  kind: 'mermaid' | 'math' | 'inline-math';
  expanded?: boolean;
}) {
  const theme = useResolvedTheme();
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);
  const deadline = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage(
      { type: 'cw-diagram-layout', expanded },
      '*',
    );
  }, [expanded]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      if (event.data?.type === 'cw-fullscreen-escape') {
        if (frame.current) exitTopFullscreen(frame.current);
        return;
      }
      if (event.data?.type !== 'cw-diagram-result') return;
      clearTimeout(deadline.current);
      if (event.data.error) setError(t('图表无法渲染，请切回源码'));
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
    void (async () => {
      if (
        new TextEncoder().encode(source).byteLength >
        (kind === 'mermaid' ? 32768 : 16384)
      )
        throw new Error(t('内容超过预览上限'));
      if (kind === 'mermaid') {
        if (active) setResult('diagram');
      } else {
        const [{ default: katex }, { default: sanitize }] = await Promise.all([
          import('katex'),
          import('dompurify'),
        ]);
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
    return () => {
      active = false;
    };
  }, [source, kind, theme]);
  if (error) return <span role="status">{error}</span>;
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
        onLoad={() => {
          clearTimeout(deadline.current);
          deadline.current = setTimeout(
            () => setError(t('图表无法渲染，请切回源码')),
            2000,
          );
          frame.current?.contentWindow?.postMessage(
            { type: 'cw-diagram', source, theme, expanded },
            '*',
          );
        }}
        onError={() => setError(t('图表无法渲染，请切回源码'))}
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

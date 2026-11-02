import { useEffect, useMemo, useRef, useState } from 'react';
import type { Event } from '../../../../packages/protocol/src/index.ts';
import { visibleEvents } from '../events.ts';
import { eventText, eventTitle, type ContentChunk } from '../conversation.tsx';
import { Copy } from '../markdown/renderer.tsx';
import { saveFile } from '../download.ts';
import { t } from '../i18n.ts';
import { FullscreenButton } from './fullscreen.tsx';
export function commandEvents(events: Event[]) {
  return visibleEvents(events).filter(
    (event) =>
      event.type === 'item/commandExecution/outputDelta' ||
      (['item/started', 'item/completed'].includes(event.type) &&
        (event.data as { item?: { type?: string } }).item?.type ===
          'commandExecution'),
  );
}
export function OutputPanel({
  events,
  chunks,
  reading,
  read,
  close,
}: {
  events: Event[];
  chunks: Record<number, ContentChunk>;
  reading: Record<number, boolean>;
  read: (seq: number, offset: number, revision: number) => void;
  close: () => void;
}) {
  const [query, setQuery] = useState('');
  const [cleared, setCleared] = useState(Number.NEGATIVE_INFINITY);
  const [follow, setFollow] = useState(true);
  const container = useRef<HTMLDivElement>(null);
  const commands = useMemo(
    () => commandEvents(events).filter((event) => event.seq > cleared),
    [events, cleared],
  );
  const lines = commands.map((event) => {
    const chunk = chunks[event.contentSeq ?? -1];
    const content =
      event.contentSeq === undefined
        ? eventText(event)
        : chunk?.revision === (event.revision ?? 0)
          ? chunk.text
          : '';
    return { event, content };
  });
  const log = lines
    .map(({ event, content }) => `${eventTitle(event)}\n${content}`)
    .join('\n\n');
  useEffect(() => {
    if (follow && container.current)
      container.current.scrollTop = container.current.scrollHeight;
  }, [log, follow]);
  return (
    <section className="command-output" aria-label={t('命令输出')}>
      <header className="pane-heading">
        <h2>{t('命令输出')}</h2>
        <FullscreenButton pane="output" />
        <button onClick={close}>{t('收起')}</button>
      </header>
      <div className="row">
        <input
          aria-label={t('查找已加载输出')}
          placeholder={t('查找已加载输出')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Copy value={log} />
        <button
          onClick={() =>
            saveFile(
              new Blob([`${t('仅包含已加载输出')}\n\n${log}`], {
                type: 'text/plain;charset=utf-8',
              }),
              'loaded-output.txt',
            )
          }
        >
          {t('导出')}
        </button>
        <button aria-pressed={follow} onClick={() => setFollow(!follow)}>
          {t('自动跟随')}
        </button>
        <button
          onClick={() =>
            setCleared(Math.max(-1, ...events.map((event) => event.seq)))
          }
        >
          {t('清屏')}
        </button>
        <button onClick={() => setCleared(Number.NEGATIVE_INFINITY)}>
          {t('恢复显示')}
        </button>
      </div>
      <small>{t('只读命令输出；清屏不删除历史，导出仅包含已加载内容。')}</small>
      <div
        className="output-scroll"
        ref={container}
        tabIndex={0}
        onWheel={(e) => {
          if (e.deltaY < 0) setFollow(false);
        }}
      >
        {lines
          .filter(
            ({ content }) =>
              !query ||
              content.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
          )
          .map(({ event, content }) => (
            <article key={event.seq}>
              <strong>{eventTitle(event)}</strong>
              <pre>{content}</pre>
              {event.contentSeq !== undefined && (
                <button
                  disabled={
                    reading[event.contentSeq] ||
                    (chunks[event.contentSeq]?.revision ===
                      (event.revision ?? 0) &&
                      !chunks[event.contentSeq]?.more)
                  }
                  onClick={() => {
                    const chunk = chunks[event.contentSeq!];
                    read(
                      event.contentSeq!,
                      chunk?.revision === (event.revision ?? 0)
                        ? chunk.nextOffset
                        : 0,
                      event.revision ?? 0,
                    );
                  }}
                >
                  {t('展开更多')}
                </button>
              )}
            </article>
          ))}
        {!commands.length && <p>{t('暂无命令输出')}</p>}
      </div>
    </section>
  );
}

import { t, useLanguage } from './i18n.ts';
import {
  memo,
  useState,
  useEffect,
  useRef,
  useMemo,
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import { MarkdownRenderer, Copy } from './markdown/renderer.tsx';
import { FileText } from './file-links.tsx';
import type { Event } from '../../../packages/protocol/src/index.ts';
import { visibleEvents } from './events.ts';
import { streamingDiffText } from './streaming-diff.ts';
import { groupToolEvents } from './events.ts';
import { Diff, ToolBody } from './tool-presentation.tsx';
import { toolModel, toolStatus, toolLabel, toolCopy } from './tool-model.ts';

export function CopyText({ text }: { text: string }) {
  useLanguage();
  const [message, setMessage] = useState('');
  return (
    <>
      <button
        onClick={() =>
          void navigator.clipboard
            .writeText(text)
            .then(() => setMessage('已复制'))
            .catch(() => setMessage('请手动选择文本复制'))
        }
      >
        {t('复制')}
      </button>
      <small role="status">{t(message)}</small>
    </>
  );
}
export { Diff, FileChanges } from './tool-presentation.tsx';
export type ContentChunk = {
  text: string;
  nextOffset: number;
  more: boolean;
  revision: number;
};
type ConversationProps = {
  events: Event[];
  chunks: Record<number, ContentChunk>;
  onRead: (seq: number, offset: number, revision: number) => void;
  reading?: Record<number, boolean>;
};
const ToolGroupOpen = createContext(true);
const EventView = memo(
  function EventView({
    event,
    cached,
    onRead,
    reading,
  }: {
    event: Event;
    cached?: ContentChunk;
    onRead: ConversationProps['onRead'];
    reading?: boolean;
  }) {
    useLanguage();
    const [expanded, setExpanded] = useState(false);
    const chat =
      event.type === 'user' || event.type === 'item/agentMessage/delta';
    const groupOpen = useContext(ToolGroupOpen);
    const diff = event.type === 'turn/diff/updated';
    const chunk =
      cached?.revision === (event.revision ?? 0) ? cached : undefined;
    const requested = useRef('');
    useEffect(() => {
      if (!expanded || !groupOpen) {
        requested.current = '';
        return;
      }
      if (chat || event.contentSeq === undefined || reading) return;
      const offset = chunk
        ? !chat && chunk.more
          ? chunk.nextOffset
          : undefined
        : 0;
      if (offset === undefined) return;
      const identity = `${event.contentSeq}:${event.revision ?? 0}:${offset}`;
      if (requested.current === identity) return;
      // Coalesce rapidly changing tool revisions. Only expanded content is read;
      // a stale response cannot satisfy a newer revision or cause an idle poll.
      const timer = setTimeout(
        () => {
          requested.current = identity;
          onRead(event.contentSeq!, offset, event.revision ?? 0);
        },
        offset ? 0 : 150,
      );
      return () => clearTimeout(timer);
    }, [
      expanded,
      groupOpen,
      chat,
      diff,
      event.contentSeq,
      event.revision,
      chunk,
      reading,
      onRead,
    ]);
    const rawContent =
      !chat && !expanded
        ? undefined
        : event.contentSeq === undefined
          ? eventText(event)
          : (chunk || (!chat ? cached : undefined))?.text;
    const content = useMemo(
      () => (diff ? streamingDiffText(rawContent || '') : rawContent),
      [diff, rawContent],
    );
    const model = useMemo(
      () => toolModel(event, rawContent),
      [event, rawContent],
    );
    const item =
      event.type === 'turn/plan/updated'
        ? { ...model.data, ...model.payload, type: 'planUpdate' }
        : model.item;
    const loading =
      !chat &&
      event.contentSeq !== undefined &&
      (!chunk || chunk.more || !!reading);
    const copyContent = item ? toolCopy(item) : content || '';
    const title = model.item
      ? eventTitle({ ...event, data: { ...model.data, item: model.item } })
      : eventTitle(event);
    const pendingCopy = useRef<
      | {
          revision: number;
          requestedOffset?: number;
          resolve: (text: string) => void;
          reject: (error: Error) => void;
          timer: ReturnType<typeof setTimeout>;
        }
      | undefined
    >(undefined);
    const [copyRequest, setCopyRequest] = useState(0);
    useEffect(
      () => () => {
        if (pendingCopy.current) {
          clearTimeout(pendingCopy.current.timer);
          pendingCopy.current.reject(new Error(t('消息读取失败，请重试')));
          pendingCopy.current = undefined;
        }
      },
      [],
    );
    useEffect(() => {
      const request = pendingCopy.current;
      if (!request) return;
      const finish = (text?: string) => {
        clearTimeout(request.timer);
        pendingCopy.current = undefined;
        if (text === undefined)
          request.reject(new Error(t('消息读取失败，请重试')));
        else request.resolve(text);
      };
      if (request.revision !== (event.revision ?? 0)) {
        clearTimeout(request.timer);
        pendingCopy.current = undefined;
        request.reject(new Error(t('消息已更新，请重新复制')));
        return;
      }
      if (chunk && !chunk.more) {
        finish(chunk.text);
        return;
      }
      if (reading) return;
      const offset = chunk?.nextOffset || 0;
      if (request.requestedOffset === offset) {
        finish();
        return;
      }
      request.requestedOffset = offset;
      onRead(event.contentSeq!, offset, event.revision ?? 0);
    }, [copyRequest, chunk, reading, event.revision, event.contentSeq, onRead]);
    const readMessage = () =>
      new Promise<string>((resolve, reject) => {
        if (pendingCopy.current) {
          reject(new Error(t('正在读取完整消息…')));
          return;
        }
        const timer = setTimeout(() => {
          pendingCopy.current = undefined;
          reject(new Error(t('消息读取失败，请重试')));
        }, 60000);
        pendingCopy.current = {
          revision: event.revision ?? 0,
          resolve,
          reject,
          timer,
        };
        setCopyRequest((value) => value + 1);
      });
    const body = (
      <>
        {chat ? (
          <div className={event.type === 'user' ? 'user-text' : 'markdown'}>
            {event.type === 'user' ? (
              <FileText text={content || ''} />
            ) : (
              <MarkdownRenderer
                text={content || ''}
                scope={`message-${event.seq}`}
              />
            )}
          </div>
        ) : (
          <>
            <Copy value={copyContent} floating />
            {item ? (
              <div className="tool-body">
                <ToolBody item={item} />
              </div>
            ) : diff || event.type === 'item/fileChange/outputDelta' ? (
              <Diff text={content || ''} />
            ) : (
              <pre tabIndex={0}>
                <FileText text={content || ''} />
              </pre>
            )}
            {item &&
              event.contentSeq !== undefined &&
              chunk &&
              !chunk.more &&
              !model.structured &&
              item.type !== 'commandExecution' &&
              content && (
                <details className="tool-original">
                  <summary>{t('原始记录')}</summary>
                  <pre tabIndex={0}>
                    <FileText text={content} />
                  </pre>
                </details>
              )}
            {loading && (
              <p className="tool-loading" role="status">
                {t('正在读取…')}
              </p>
            )}
          </>
        )}
        {event.contentSeq !== undefined && (!item || !chunk || chunk.more) && (
          <>
            <button
              onClick={() =>
                onRead(
                  event.contentSeq!,
                  chunk?.nextOffset || 0,
                  event.revision ?? 0,
                )
              }
              disabled={reading || (!!chunk && !chunk.more)}
            >
              {reading
                ? t('正在读取…')
                : chunk
                  ? chunk.more
                    ? t('展开更多')
                    : t('已读完')
                  : t('展开内容')}
            </button>
          </>
        )}
      </>
    );
    return chat ? (
      <article
        key={event.seq}
        data-event-seq={event.seq}
        tabIndex={0}
        className={`message ${event.type === 'user' ? 'user-message' : 'assistant-message'}`}
      >
        <Copy
          value={content || ''}
          label={t('复制消息')}
          floating
          read={
            event.contentSeq !== undefined && (!chunk || chunk.more)
              ? readMessage
              : undefined
          }
        />
        <strong className="message-role">{title}</strong>
        {body}
      </article>
    ) : (
      <details
        tabIndex={0}
        className="tool-output"
        aria-busy={
          !chat && expanded && event.contentSeq !== undefined
            ? !chunk || chunk.more || !!reading
            : undefined
        }
        data-event-seq={event.seq}
        key={event.seq}
        onToggle={(event) => {
          if (event.target === event.currentTarget)
            setExpanded(event.currentTarget.open);
        }}
      >
        <summary title={title}>{title}</summary>
        {expanded ? body : null}
      </details>
    );
  },
  (previous, next) =>
    previous.cached === next.cached &&
    previous.reading === next.reading &&
    previous.onRead === next.onRead &&
    previous.event.seq === next.event.seq &&
    previous.event.revision === next.event.revision &&
    previous.event.type === next.event.type &&
    previous.event.contentSeq === next.event.contentSeq &&
    previous.event.data === next.event.data,
);

export const ConversationView = memo(function ConversationView({
  events,
  chunks,
  onRead,
  reading = {},
}: ConversationProps) {
  useLanguage();
  const render = (event: Event) => (
    <EventView
      key={event.seq}
      event={event}
      cached={chunks[event.contentSeq ?? event.seq]}
      onRead={onRead}
      reading={reading[event.contentSeq ?? event.seq]}
    />
  );
  return groupToolEvents(
    visibleEvents(events).filter(
      (e) =>
        !['turn/started', 'approvalResolved'].includes(e.type) &&
        !(
          e.type === 'turn/completed' &&
          (e.data as { turn?: { status?: string } }).turn?.status ===
            'completed'
        ),
    ),
  ).map((group) =>
    group.tools ? (
      <ToolGroupView key={`tools:${group.events[0].seq}`} events={group.events}>
        {group.events.map(render)}
      </ToolGroupView>
    ) : (
      render(group.events[0])
    ),
  );
});
function ToolGroupView({
  events,
  children,
}: {
  events: Event[];
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="tool-group"
      data-event-seq={events[0].seq}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setOpen(event.currentTarget.open);
      }}
    >
      <summary>
        {t('工具调用 ·')} {events.length} {t('项')}
        {events.some(toolFailed) ? t(' · 含失败') : ''}
      </summary>
      <ToolGroupOpen.Provider value={open}>{children}</ToolGroupOpen.Provider>
    </details>
  );
}
function toolFailed(e: Event) {
  const item = (e.data as { item?: Record<string, unknown> }).item;
  return !!item && toolStatus(item) === t('失败');
}
export function eventTitle(e: Event) {
  const data = e.data as { item?: Record<string, unknown> };
  if (data.item) {
    const item = data.item;
    return `${toolLabel(item)} · ${toolStatus(item, e.type === 'item/completed')}${item.exitCode != null ? ` · ${t('退出码 {0}', item.exitCode)}` : ''}`;
  }
  return (
    (
      {
        user: t('你'),
        'item/agentMessage/delta': 'Codex',
        'turn/started': t('开始任务'),
        'turn/completed': t('本轮结束'),
        'turn/diff/updated': t('代码差异'),
        'turn/plan/updated': t('执行计划'),
        'item/started': t('工具操作'),
        'item/completed': t('工具结果'),
        'item/commandExecution/outputDelta': t('命令输出'),
        'item/fileChange/outputDelta': t('文件变更'),
        'item/mcpToolCall/progress': t('工具进度'),
        'item/plan/delta': t('执行计划'),
        'item/reasoning/summaryTextDelta': t('思考摘要'),
        'item/reasoning/textDelta': t('思考过程'),
        queueAccepted: t('已加入原客户端队列 · 等待执行'),
        warning: t('提示'),
        error: t('错误'),
        approvalResolved: t('审批结果'),
        sessionClosed: t('会话结束'),
      } as Record<string, string>
    )[e.type] || t('任务活动')
  );
}
export function eventText(e: Event): string {
  const d = e.data as any;
  if (e.type === 'turn/started') return t('任务已开始。');
  if (e.type === 'turn/completed')
    return d.turn?.status === 'completed'
      ? t('任务已完成。')
      : t('任务已停止或失败：') +
          (d.turn?.error?.message || d.turn?.status || t('未知状态'));
  if (e.type === 'approvalResolved' && d.external)
    return d.message || t('原客户端已解决此审批；以执行结果为准。');
  if (e.type === 'approvalResolved')
    return d.allow ? t('已允许该操作。') : t('已拒绝该操作。');
  if (e.type === 'sessionClosed') return t('会话已结束：') + d.state;
  if (e.type === 'turn/plan/updated')
    return (
      (d.explanation || '') +
      '\n' +
      (d.plan || [])
        .map((step: any) => step.status + ' · ' + step.step)
        .join('\n')
    );
  if (['item/started', 'item/completed'].includes(e.type))
    return d.item?.command
      ? [
          d.item.command,
          d.item.aggregatedOutput,
          d.item.exitCode != null ? t('退出码：') + d.item.exitCode : '',
        ]
          .filter(Boolean)
          .join('\n\n')
      : JSON.stringify(d.item || {}, null, 2);
  return (
    d.text ||
    d.delta ||
    d.diff ||
    d.message ||
    d.error?.message ||
    t('状态已更新。')
  );
}

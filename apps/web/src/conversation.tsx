import { t, useLanguage } from './i18n.ts';
import {
  memo,
  useState,
  useEffect,
  useRef,
  useContext,
  Children,
  isValidElement,
  type ReactNode,
} from 'react';
import Markdown, { defaultUrlTransform } from 'react-markdown';
import {
  FileContext,
  FileLink,
  FileText,
  projectFilePath,
  remarkFileLinks,
} from './file-links.tsx';
import remarkGfm from 'remark-gfm';
import type { Event } from '../../../packages/protocol/src/index.ts';
import { visibleEvents } from './events.ts';
import { groupToolEvents } from './events.ts';

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
function plainText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === 'string' || typeof child === 'number'
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? plainText(child.props.children)
          : '',
    )
    .join('');
}
export function Diff({ text }: { text: string }) {
  return (
    <pre tabIndex={0}>
      {text.split('\n').map((line, index) => (
        <span
          className={
            line.startsWith('+')
              ? 'diff-add'
              : line.startsWith('-')
                ? 'diff-remove'
                : undefined
          }
          key={index}
        >
          {line}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}
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
    const fileContext = useContext(FileContext);
    const chat =
      event.type === 'user' || event.type === 'item/agentMessage/delta';
    const chunk =
      cached?.revision === (event.revision ?? 0) ? cached : undefined;
    const requested = useRef('');
    useEffect(() => {
      if (!expanded) {
        requested.current = '';
        return;
      }
      if (chat || event.contentSeq === undefined || chunk || reading) return;
      const identity = `${event.contentSeq}:${event.revision ?? 0}`;
      if (requested.current === identity) return;
      // Coalesce rapidly changing tool revisions. Only expanded content is read;
      // a stale response cannot satisfy a newer revision or cause an idle poll.
      const timer = setTimeout(() => {
        requested.current = identity;
        onRead(event.contentSeq!, 0, event.revision ?? 0);
      }, 150);
      return () => clearTimeout(timer);
    }, [
      expanded,
      chat,
      event.contentSeq,
      event.revision,
      chunk,
      reading,
      onRead,
    ]);
    const content =
      !chat && !expanded
        ? undefined
        : event.contentSeq === undefined
          ? eventText(event)
          : chunk?.text;
    const body = (
      <>
        {chat ? (
          <div className={event.type === 'user' ? 'user-text' : 'markdown'}>
            {event.type === 'user' ? (
              <FileText text={content || ''} />
            ) : (
              <Markdown
                remarkPlugins={[remarkGfm, remarkFileLinks]}
                urlTransform={(url) =>
                  fileContext && projectFilePath(url, fileContext.root)
                    ? url
                    : defaultUrlTransform(url)
                }
                components={{
                  code: ({ children, className }) => (
                    <code className={className}>
                      <FileText text={plainText(children)} />
                    </code>
                  ),
                  pre: ({ children }) => (
                    <div className="code-block">
                      <CopyText text={plainText(children)} />
                      <pre>{children}</pre>
                    </div>
                  ),
                  a: ({ children, href }) => (
                    <FileLink href={href}>{children}</FileLink>
                  ),
                  img: ({ alt, src }) => (
                    <FileLink href={typeof src === 'string' ? src : undefined}>
                      {alt || t('图片')}
                    </FileLink>
                  ),
                }}
              >
                {content || ''}
              </Markdown>
            )}
          </div>
        ) : (
          <>
            <CopyText text={content || ''} />
            {event.type === 'turn/diff/updated' ? (
              <Diff text={content || ''} />
            ) : (
              <pre tabIndex={0}>
                <FileText text={content || ''} />
              </pre>
            )}
          </>
        )}
        {event.contentSeq !== undefined && (
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
        className={`message ${event.type === 'user' ? 'user-message' : 'assistant-message'}`}
      >
        <strong className="message-role">{eventTitle(event)}</strong>
        {body}
      </article>
    ) : (
      <details
        className="tool-output"
        data-event-seq={event.seq}
        key={event.seq}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>{eventTitle(event)}</summary>
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
      <details
        className="tool-group"
        key={`tools:${group.events[0].seq}`}
        data-event-seq={group.events[0].seq}
      >
        <summary>
          {t('工具调用 ·')} {group.events.length} {t('项')}
          {group.events.some(toolFailed) ? t(' · 含失败') : ''}
        </summary>
        {group.events.map(render)}
      </details>
    ) : (
      render(group.events[0])
    ),
  );
});
function toolFailed(e: Event) {
  const d = e.data as { item?: { exitCode?: number; status?: string } };
  return (
    (d.item?.exitCode != null && d.item.exitCode !== 0) ||
    d.item?.status === 'failed'
  );
}
function eventTitle(e: Event) {
  const data = e.data as {
    item?: {
      command?: string;
      type?: string;
      status?: string;
      exitCode?: number;
      changes?: unknown[];
    };
  };
  if (data.item) {
    const item = data.item;
    const label =
      item.command ||
      (item.type === 'fileChange'
        ? t(
            '修改文件{0}',
            item.changes ? t(' · {0} 项', item.changes.length) : '',
          )
        : t('工具调用'));
    return `${label} · ${item.exitCode != null ? t('退出码 {0}', item.exitCode) : e.type === 'item/completed' ? t('已完成') : t('进行中')}`;
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
        queueAccepted: t('已加入原客户端队列 · 等待执行'),
        warning: t('提示'),
        error: t('错误'),
        approvalResolved: t('审批结果'),
        sessionClosed: t('会话结束'),
      } as Record<string, string>
    )[e.type] || t('任务活动')
  );
}
function eventText(e: Event): string {
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

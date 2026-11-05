import type { IconName } from '../happier/icon.tsx';
import { IconButton } from '../happier/icon-button.tsx';
import { useEffect, useRef, useState } from 'react';
import type { Event } from '../../../../packages/protocol/src/index.ts';
import { eventText, eventTitle, type ContentChunk } from '../conversation.tsx';
import { visibleEvents } from '../events.ts';
import { saveFile } from '../download.ts';
import { t } from '../i18n.ts';
export function WorkbenchActions({
  scope,
  events,
  chunks,
  actions,
}: {
  scope: string;
  events: Event[];
  chunks: Record<number, ContentChunk>;
  actions: { label: string; icon?: IconName; run: () => void }[];
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [shortcut, setShortcut] = useState(() => {
    try {
      return localStorage.getItem('coc-workbench-shortcut') === 'true';
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('coc-workbench-shortcut', String(shortcut));
    } catch {
      /* Optional preference. */
    }
    if (!shortcut) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.isComposing ||
        (event.target instanceof Element &&
          event.target.closest(
            '.interactive-terminal, input, textarea, [contenteditable]',
          ))
      )
        return;
      if (event.ctrlKey && event.altKey && event.code === 'KeyK') {
        event.preventDefault();
        dialog.current?.showModal();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [shortcut]);
  useEffect(() => {
    dialog.current?.close();
  }, [scope]);
  function exportLoaded() {
    const content = visibleEvents(events)
      .map((event) => {
        const chunk = chunks[event.contentSeq ?? -1];
        const body =
          event.contentSeq === undefined
            ? eventText(event)
            : chunk?.revision === (event.revision ?? 0)
              ? chunk.text
              : t('正文尚未加载');
        return `## ${eventTitle(event)}\n\n${body}`;
      })
      .join('\n\n');
    saveFile(
      new Blob([`${t('仅包含已加载消息，可能不完整。')}\n\n${content}`], {
        type: 'text/markdown;charset=utf-8',
      }),
      'loaded-conversation.md',
    );
  }
  return (
    <>
      <IconButton
        showLabel
        icon="more"
        label={t('快捷操作')}
        ref={trigger}
        type="button"
        onClick={() => dialog.current?.showModal()}
      />
      <IconButton
        showLabel
        icon="download"
        label={t('导出已加载对话')}
        type="button"
        onClick={exportLoaded}
      />
      <label>
        <input
          type="checkbox"
          checked={shortcut}
          onChange={(event) => setShortcut(event.target.checked)}
        />
        {t('启用 Ctrl+Alt+K 快捷操作')}
      </label>
      <dialog
        className="workbench-actions"
        ref={dialog}
        aria-label={t('快捷操作')}
      >
        <header className="pane-heading">
          <h2>{t('快捷操作')}</h2>
          <IconButton
            icon="close"
            label={t('关闭')}
            onClick={() => dialog.current?.close()}
          />
        </header>
        <div className="dialog-action-list">
          {actions.map((action) => (
            <IconButton
              showLabel
              key={action.label}
              icon={action.icon || 'more'}
              label={action.label}
              onClick={() => {
                dialog.current?.close();
                action.run();
              }}
            />
          ))}
        </div>
      </dialog>
    </>
  );
}

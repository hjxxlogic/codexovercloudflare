// UI structure adapted from happier-dev/happier (MIT), pinned in SOURCE.md.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icon.tsx';
import { t, useLanguage } from '../i18n.ts';
import './session-workspace.css';

type Props = {
  children: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettings: () => void;
};
export function SessionNavigation({
  children,
  open,
  onOpenChange,
  onSettings,
}: Props) {
  useLanguage();
  const [mobile, setMobile] = useState(
    () => matchMedia('(max-width: 900px)').matches,
  );
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = matchMedia('(max-width: 900px)');
    const update = () => {
      setMobile(media.matches);
      onOpenChange(!media.matches);
    };
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [onOpenChange]);
  useEffect(() => {
    if (!mobile) return;
    if (open && !drawer.current?.open) drawer.current?.showModal();
    if (!open && drawer.current?.open) drawer.current?.close();
  }, [open, mobile]);
  const close = () => {
    onOpenChange(false);
    trigger.current?.focus();
  };
  const content = (
    <>
      <div className="happier-sidebar-heading">
        <strong>
          <span className="happier-app-mark">
            <Icon name="chat" size={21} />
          </span>
          CoC <span>CW</span>
        </strong>
        <button
          onClick={close}
          aria-label={t('关闭会话导航')}
          title={t('收起侧栏')}
        >
          <Icon name="menu" />
        </button>
      </div>
      <div className="navigation-content">{children}</div>
      <div className="navigation-footer">
        <button onClick={onSettings} aria-label={t('设置')}>
          <Icon name="settings" /> <span>{t('设置')}</span>
        </button>
        <a
          className="happier-attribution"
          href="./happier-LICENSE.txt"
          target="_blank"
          rel="noreferrer"
        >
          Happier UI · MIT
        </a>
      </div>
    </>
  );
  return (
    <>
      {(!open || mobile) && (
        <button
          className="happier-navigation-toggle"
          ref={trigger}
          onClick={() => onOpenChange(true)}
          aria-label={t('打开会话导航')}
          aria-expanded={open}
        >
          <Icon name="menu" />
        </button>
      )}
      {mobile ? (
        <dialog
          className="happier-sidebar happier-drawer unified-navigation"
          ref={drawer}
          aria-label={t('会话导航')}
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClose={() => onOpenChange(false)}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              close();
          }}
        >
          {content}
        </dialog>
      ) : (
        open && (
          <aside
            className="happier-sidebar unified-navigation"
            aria-label={t('会话导航')}
          >
            {content}
          </aside>
        )
      )}
    </>
  );
}
export function SessionHeading({
  title,
  project,
  status,
  busy,
  context,
  actions,
}: {
  title: string;
  project: string;
  status: string;
  busy: boolean;
  context?: ReactNode;
  actions: ReactNode;
}) {
  useLanguage();
  return (
    <header className="happier-session-heading">
      <div className="happier-session-title">
        <h1>{title}</h1>
        {context || (
          <small>
            {project}
            {project && ' · '}
            {busy ? t('正在处理任务') : status}
          </small>
        )}
      </div>
      <div
        className="happier-session-actions"
        role="group"
        aria-label={t('当前会话操作')}
      >
        {actions}
      </div>
    </header>
  );
}

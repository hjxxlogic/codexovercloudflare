// UI structure adapted from happier-dev/happier (MIT), pinned in SOURCE.md.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './icon.tsx';
import { IconButton } from './icon-button.tsx';
import { t, useLanguage } from '../i18n.ts';
import './session-workspace.css';

type Props = {
  children: ReactNode;
  email?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSettings: () => void;
};
export function SessionNavigation({
  children,
  email,
  open,
  onOpenChange,
  onSettings,
}: Props) {
  useLanguage();
  const [mobile, setMobile] = useState(
    () => matchMedia('(max-width: 900px)').matches,
  );
  const drawer = useRef<HTMLDialogElement>(null);
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
    requestAnimationFrame(() =>
      document
        .querySelector<HTMLButtonElement>('.happier-navigation-toggle')
        ?.focus(),
    );
  };
  const content = (
    <>
      <div className="happier-sidebar-heading">
        <strong>
          <span className="happier-app-mark">
            <Icon name="chat" size={21} />
          </span>
          <span className="navigation-username">
            {email?.split('@')[0] || t('用户')}
          </span>
        </strong>
        <IconButton icon="menu" label={t('关闭会话导航')} onClick={close} />
      </div>
      <div className="navigation-content">{children}</div>
      <div className="navigation-footer">
        <IconButton icon="settings" label={t('设置')} onClick={onSettings} />
      </div>
    </>
  );
  return (
    <>
      {(!open || mobile) && (
        <IconButton
          icon="menu"
          className="happier-navigation-toggle"
          onClick={() => onOpenChange(true)}
          label={t('打开会话导航')}
          aria-expanded={open}
        />
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
  actions,
  notice,
}: {
  actions: ReactNode;
  notice?: ReactNode;
}) {
  useLanguage();
  return (
    <header className="happier-session-heading">
      <div
        className="happier-session-actions"
        role="group"
        aria-label={t('当前会话操作')}
      >
        {actions}
      </div>
      {notice}
    </header>
  );
}

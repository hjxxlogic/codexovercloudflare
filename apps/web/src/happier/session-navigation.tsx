// UI structure adapted from happier-dev/happier (MIT), pinned in SOURCE.md.
import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { SessionHistory } from '../session-history.tsx';
import { t, useLanguage } from '../i18n.ts';
import './session-workspace.css';

type Props = Omit<ComponentProps<typeof SessionHistory>, 'search'> & {
  hostName: string;
  onNew: () => void;
  onConnect: () => void;
  onHistory: () => void;
};

export function SessionNavigation(props: Props) {
  useLanguage();
  const [search, setSearch] = useState('');
  const [mobile, setMobile] = useState(
    () => matchMedia('(max-width: 900px)').matches,
  );
  const drawer = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const media = matchMedia('(max-width: 900px)');
    const update = () => setMobile(media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  const close = () => drawer.current?.close();
  const content = (
    <>
      <div className="happier-sidebar-heading">
        <strong>
          CoC <span>CW</span>
        </strong>
        {mobile && (
          <button onClick={close} aria-label={t('关闭会话导航')}>
            ×
          </button>
        )}
      </div>
      <button
        className="happier-new"
        disabled={props.creating}
        onClick={() => {
          close();
          props.onNew();
        }}
      >
        <span aria-hidden="true">＋</span> {t('新建对话')}
      </button>
      <input
        aria-label={t('搜索会话导航')}
        placeholder={t('搜索会话…')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div className="happier-project">
        <button
          onClick={() => {
            close();
            props.onConnect();
          }}
          title={t('连接远程项目')}
        >
          <span className={`happier-dot${props.online ? ' online' : ''}`} />
          <span>
            {props.projectName || t('选择远程项目')}
            <small>{props.hostName || t('尚未连接主机')}</small>
          </span>
        </button>
      </div>
      <div className="happier-session-list">
        <p className="happier-section-label">{t('会话')}</p>
        <SessionHistory
          {...props}
          search={search}
          onSelect={(session) => {
            close();
            props.onSelect(session);
          }}
          onResume={(thread) => {
            close();
            props.onResume(thread);
          }}
        />
      </div>
      <button
        className="happier-history"
        onClick={() => {
          close();
          props.onHistory();
        }}
      >
        {t('全部历史记录')} <span aria-hidden="true">↗</span>
      </button>
      <a
        className="happier-attribution"
        href="./happier-LICENSE.txt"
        target="_blank"
        rel="noreferrer"
      >
        Happier UI · MIT
      </a>
    </>
  );
  if (!mobile)
    return (
      <aside className="happier-sidebar" aria-label={t('会话导航')}>
        {content}
      </aside>
    );
  return (
    <>
      <button
        className="happier-navigation-toggle"
        ref={trigger}
        onClick={() => drawer.current?.showModal()}
        aria-label={t('打开会话导航')}
      >
        ☰ <span>{t('会话')}</span>
      </button>
      <dialog
        className="happier-sidebar happier-drawer"
        ref={drawer}
        aria-label={t('会话导航')}
        onClose={() => trigger.current?.focus()}
        onClick={(event) => {
          if (event.target === event.currentTarget) {
            const rect = event.currentTarget.getBoundingClientRect();
            if (
              event.clientX < rect.left ||
              event.clientX > rect.right ||
              event.clientY < rect.top ||
              event.clientY > rect.bottom
            )
              close();
          }
        }}
      >
        {content}
      </dialog>
    </>
  );
}

export function SessionHeading({
  title,
  project,
  status,
  busy,
  onFiles,
  onDetails,
}: {
  title: string;
  project: string;
  status: string;
  busy: boolean;
  onFiles: () => void;
  onDetails: () => void;
}) {
  useLanguage();
  return (
    <header className="happier-session-heading">
      <div>
        <h1>{title}</h1>
        <small>
          {project}
          {project && ' · '}
          {busy ? t('正在处理任务') : status}
        </small>
      </div>
      <div
        className="happier-session-actions"
        role="group"
        aria-label={t('当前会话操作')}
      >
        <button onClick={onFiles}>{t('文件')}</button>
        <button onClick={onDetails} aria-label={t('打开会话详情')}>
          ⓘ
        </button>
      </div>
    </header>
  );
}

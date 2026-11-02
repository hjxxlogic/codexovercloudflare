import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { Event } from '../../../../packages/protocol/src/index.ts';
import type { ContentChunk } from '../conversation.tsx';
import { Explorer } from './explorer.tsx';
import { WorkbenchActions } from './actions.tsx';
import { useWorkbenchAttention } from './attention.ts';
import { Preview } from './preview.tsx';
import { OutputPanel } from './output.tsx';
import { t, useLanguage } from '../i18n.ts';
import './workbench.css';
import { PreviewContext } from './context.ts';
import { FileContext } from '../file-links.tsx';
import type { ControlProof } from '../../../../packages/protocol/src/index.ts';
import type { OperationClient } from '../operations.ts';
const InteractiveTerminal = lazy(() => import('./terminal.tsx'));
type Preferences = {
  theme: 'dark' | 'light' | 'system';
  density: 'standard' | 'compact';
  files: boolean;
  width: number;
  output: boolean;
  height: number;
};
const defaults: Preferences = {
  theme: 'system',
  density: 'standard',
  files: false,
  width: 256,
  output: false,
  height: 240,
};
export function readPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem('coc-workbench-v1') || '{}');
    return {
      theme: ['dark', 'light', 'system'].includes(value.theme)
        ? value.theme
        : defaults.theme,
      density: value.density === 'compact' ? 'compact' : 'standard',
      files: value.files === true,
      output: value.output === true,
      width: Math.min(360, Math.max(220, Number(value.width) || 256)),
      height: Math.min(500, Math.max(160, Number(value.height) || 240)),
    };
  } catch {
    return defaults;
  }
}
export function Workbench({
  children,
  host,
  project,
  root: projectRoot = '',
  session,
  events,
  chunks,
  reading,
  read,
  upload,
  reference,
  terminal,
  activity,
}: {
  children: ReactNode;
  host: string;
  project: string;
  root?: string;
  session?: string;
  events: Event[];
  chunks: Record<number, ContentChunk>;
  reading: Record<number, boolean>;
  read: (seq: number, offset: number, revision: number) => void;
  upload: () => void;
  reference: (path: string) => void;
  activity: { busy: boolean; ready: boolean; approvals: string[] };
  terminal: {
    control?: ControlProof;
    operations?: OperationClient | null;
    enabled: boolean;
  };
}) {
  useLanguage();
  const [preferences, setPreferences] = useState(readPreferences);
  const [preview, setPreview] = useState<{ path: string; scope: string }>();
  const previewScope = JSON.stringify([host, project, session]);
  const path = preview?.scope === previewScope ? preview.path : '';
  const setPath = (value: string) =>
    setPreview({ path: value, scope: previewScope });
  const attention = useWorkbenchAttention(
    previewScope,
    activity.busy,
    activity.ready,
    activity.approvals,
    events,
  );
  const [terminalShown, setTerminalShown] = useState(false);
  const [terminalLoaded, setTerminalLoaded] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [search, setSearch] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const update = (value: Partial<Preferences>) =>
    setPreferences((old) => ({ ...old, ...value }));
  useEffect(() => {
    try {
      localStorage.setItem('coc-workbench-v1', JSON.stringify(preferences));
    } catch {
      /* Private browsing remains functional. */
    }
  }, [preferences]);
  useEffect(() => {
    setPath('');
    setSearch('');
  }, [host, project, session]);
  function findNext() {
    if (!search.trim()) return;
    const nodes = Array.from(
      root.current?.querySelectorAll<HTMLElement>('.message, .tool-output') ||
        [],
    );
    const selected = nodes.findIndex(
      (node) => node.dataset.searchCurrent === 'true',
    );
    nodes.forEach((node) => {
      delete node.dataset.searchCurrent;
    });
    const ordered = [
      ...nodes.slice(selected + 1),
      ...nodes.slice(0, selected + 1),
    ];
    const hit = ordered.find((node) =>
      node.textContent
        ?.toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    );
    if (hit) {
      hit.dataset.searchCurrent = 'true';
      hit.scrollIntoView({ block: 'center' });
    }
  }
  return (
    <FileContext.Provider value={{ host, project, root: projectRoot }}>
      <PreviewContext.Provider value={setPath}>
        <div
          className={`cw-workbench density-${preferences.density}${terminalShown ? ' terminal-visible' : ''}`}
          data-theme={preferences.theme}
          ref={root}
          style={
            {
              '--sidebar-width': `${preferences.width}px`,
              '--output-height': `${preferences.height}px`,
            } as React.CSSProperties
          }
        >
          <div className="workbench-toolbar" aria-label={t('工作台工具栏')}>
            <button
              aria-pressed={preferences.files}
              onClick={() => update({ files: !preferences.files })}
            >
              {t('文件浏览器')}
            </button>
            <button
              aria-pressed={preferences.output}
              onClick={() => {
                setTerminalShown(false);
                update({ output: !preferences.output });
              }}
            >
              {t('命令输出')}
            </button>
            <button
              aria-pressed={terminalShown}
              onClick={() => {
                setTerminalLoaded(true);
                setAppearance(false);
                update({ output: false });
                setTerminalShown(!terminalShown);
              }}
            >
              Terminal
            </button>
            <button
              aria-expanded={appearance}
              onClick={() => setAppearance(!appearance)}
            >
              {t('外观')}
            </button>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                findNext();
              }}
            >
              <input
                aria-label={t('搜索已加载对话')}
                placeholder={t('搜索已加载对话')}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <button type="submit">{t('查找下一个')}</button>
            </form>
          </div>
          {appearance && (
            <div className="appearance-panel">
              <button
                type="button"
                aria-pressed={attention.enabled}
                onClick={() => void attention.toggle()}
              >
                {attention.enabled ? t('关闭页面通知') : t('启用页面通知')}
              </button>
              <small role="status">{attention.notice}</small>
              <WorkbenchActions
                scope={previewScope}
                events={events}
                chunks={chunks}
                actions={[
                  {
                    label: t('文件浏览器'),
                    run: () => update({ files: true }),
                  },
                  {
                    label: t('命令输出'),
                    run: () => {
                      setTerminalShown(false);
                      update({ output: true });
                    },
                  },
                  {
                    label: 'Terminal',
                    run: () => {
                      setTerminalLoaded(true);
                      setAppearance(false);
                      update({ output: false });
                      setTerminalShown(true);
                    },
                  },
                  {
                    label: t('搜索已加载对话'),
                    run: () =>
                      root.current
                        ?.querySelector<HTMLInputElement>(
                          '.workbench-toolbar input',
                        )
                        ?.focus(),
                  },
                  { label: t('上传 / 传输'), run: upload },
                ]}
              />
              <label>
                {t('主题')}
                <select
                  aria-label={t('主题')}
                  value={preferences.theme}
                  onChange={(e) =>
                    update({ theme: e.target.value as Preferences['theme'] })
                  }
                >
                  <option value="system">{t('跟随系统')}</option>
                  <option value="dark">{t('深色')}</option>
                  <option value="light">{t('浅色')}</option>
                </select>
              </label>
              <label>
                {t('密度')}
                <select
                  aria-label={t('密度')}
                  value={preferences.density}
                  onChange={(e) =>
                    update({
                      density: e.target.value as Preferences['density'],
                    })
                  }
                >
                  <option value="standard">{t('标准')}</option>
                  <option value="compact">{t('紧凑')}</option>
                </select>
              </label>
              <label>
                {t('侧栏宽度')}
                <input
                  type="range"
                  min="220"
                  max="360"
                  value={preferences.width}
                  onChange={(e) => update({ width: Number(e.target.value) })}
                />
              </label>
              <label>
                {t('输出面板高度')}
                <input
                  type="range"
                  min="160"
                  max="500"
                  value={preferences.height}
                  onChange={(e) => update({ height: Number(e.target.value) })}
                />
              </label>
            </div>
          )}
          <div className="workbench-body">
            {preferences.files && (
              <aside className="workbench-sidebar">
                <Explorer
                  key={`${host}:${project}`}
                  host={host}
                  project={project}
                  open={setPath}
                  upload={upload}
                />
              </aside>
            )}
            <div className="workbench-conversation">{children}</div>
            {path && (
              <Preview
                key={`${host}:${project}:${path}`}
                host={host}
                project={project}
                path={path}
                close={() => setPath('')}
                reference={(value) => {
                  reference(value);
                  setPath('');
                }}
              />
            )}
          </div>
          {terminalLoaded && (
            <Suspense fallback={<p role="status">{t('正在读取…')}</p>}>
              <InteractiveTerminal
                key={`${host}:${project}:${session}`}
                host={host}
                project={project}
                session={session}
                {...terminal}
                visible={terminalShown}
                close={() => setTerminalShown(false)}
              />
            </Suspense>
          )}
          {preferences.output && (
            <OutputPanel
              key={session || ''}
              events={events}
              chunks={chunks}
              reading={reading}
              read={read}
              close={() => update({ output: false })}
            />
          )}
        </div>
      </PreviewContext.Provider>
    </FileContext.Provider>
  );
}

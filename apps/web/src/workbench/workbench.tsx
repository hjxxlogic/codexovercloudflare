import { createPortal } from 'react-dom';
import { ResizeHandle } from './resize-handle.tsx';
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
import { ThemeContext } from '../theme.ts';
import { FullscreenContext, usePaneFullscreen } from './fullscreen.tsx';
import type { ControlProof } from '../../../../packages/protocol/src/index.ts';
import type { OperationClient } from '../operations.ts';
import { queryApi } from '../api.ts';
import type { TerminalMetadata } from './terminal.tsx';
const loadTerminal = () => import('./terminal.tsx');
const InteractiveTerminal = lazy(loadTerminal);
type Preferences = {
  theme: 'dark' | 'light' | 'system';
  density: 'standard' | 'compact';
  files: boolean;
  width: number;
  output: boolean;
  height: number;
  previewWidth: number;
  terminalHeight: number;
};
const defaults: Preferences = {
  theme: 'system',
  density: 'standard',
  files: false,
  width: 256,
  output: false,
  height: 240,
  previewWidth: 420,
  terminalHeight: 360,
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
      width: Math.min(640, Math.max(220, Number(value.width) || 256)),
      height: Math.min(800, Math.max(160, Number(value.height) || 240)),
      previewWidth: Math.min(
        900,
        Math.max(280, Number(value.previewWidth) || 420),
      ),
      terminalHeight: Math.min(
        900,
        Math.max(220, Number(value.terminalHeight) || 360),
      ),
    };
  } catch {
    return defaults;
  }
}
export function Workbench({
  children,
  menuTarget,
  closeMenu,
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
  menuTarget: HTMLElement | null;
  closeMenu: () => void;
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
  const setPath = (value: string) => {
    fullscreen.exit();
    setPreview({ path: value, scope: previewScope });
  };
  const attention = useWorkbenchAttention(
    previewScope,
    activity.busy,
    activity.ready,
    activity.approvals,
    events,
  );
  const [terminalShown, setTerminalShown] = useState(false);
  const [terminalLoaded, setTerminalLoaded] = useState(false);
  const terminalScope = JSON.stringify([
    host,
    project,
    terminal.control?.owner,
  ]);
  const preparation = useRef<{
    scope: string;
    time: number;
    promise: Promise<TerminalMetadata>;
  }>(undefined);
  function prepareTerminal() {
    void loadTerminal().catch(() => {});
    if (terminalLoaded || !host || !project) return;
    if (
      preparation.current?.scope === terminalScope &&
      Date.now() - preparation.current.time < 5000
    )
      return;
    const promise = queryApi(`/hosts/${host}/terminal`, {
      operation: 'info',
      projectId: project,
    });
    // A failed speculative read is shown if the user opens the terminal.
    void promise.catch(() => {});
    preparation.current = { scope: terminalScope, time: Date.now(), promise };
  }
  const [appearance, setAppearance] = useState(false);
  const [search, setSearch] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const fullscreen = usePaneFullscreen(root, previewScope);
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
    <ThemeContext.Provider value={preferences.theme}>
      <FullscreenContext.Provider value={fullscreen}>
        <FileContext.Provider value={{ host, project, root: projectRoot }}>
          <PreviewContext.Provider value={setPath}>
            <div
              className={`cw-workbench density-${preferences.density}${terminalShown ? ' terminal-visible' : ''}`}
              data-theme={preferences.theme}
              data-fullscreen={fullscreen.pane || undefined}
              ref={root}
              style={
                {
                  '--sidebar-width': `${preferences.width}px`,
                  '--output-height': `${preferences.height}px`,
                  '--preview-width': `${preferences.previewWidth}px`,
                  '--terminal-height': `${preferences.terminalHeight}px`,
                } as React.CSSProperties
              }
            >
              {menuTarget &&
                createPortal(
                  <>
                    <button
                      aria-pressed={preferences.files}
                      onClick={() => {
                        update({ files: !preferences.files });
                        closeMenu();
                      }}
                    >
                      {t('文件浏览器')}
                    </button>
                    <button
                      aria-pressed={preferences.output}
                      onClick={() => {
                        closeMenu();
                        setTerminalShown(false);
                        update({ output: !preferences.output });
                      }}
                    >
                      {t('命令输出')}
                    </button>
                    <button
                      aria-pressed={terminalShown}
                      onPointerEnter={prepareTerminal}
                      onFocus={prepareTerminal}
                      onClick={() => {
                        prepareTerminal();
                        closeMenu();
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
                      onClick={() => {
                        setAppearance(!appearance);
                        closeMenu();
                      }}
                    >
                      {t('外观')}
                    </button>
                  </>,
                  menuTarget,
                )}
              {appearance && (
                <div className="appearance-panel">
                  <button
                    onClick={() => setAppearance(false)}
                    aria-label={t('关闭外观')}
                  >
                    {t('关闭')}
                  </button>
                  <form
                    className="workbench-search"
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
                          prepareTerminal();
                          setTerminalLoaded(true);
                          setAppearance(false);
                          update({ output: false });
                          setTerminalShown(true);
                        },
                      },
                      {
                        label: t('搜索已加载对话'),
                        run: () => {
                          setAppearance(true);
                          requestAnimationFrame(() =>
                            root.current
                              ?.querySelector<HTMLInputElement>(
                                '.workbench-search input',
                              )
                              ?.focus(),
                          );
                        },
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
                        update({
                          theme: e.target.value as Preferences['theme'],
                        })
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
                      max="640"
                      value={preferences.width}
                      onChange={(e) =>
                        update({ width: Number(e.target.value) })
                      }
                    />
                  </label>
                  <label>
                    {t('输出面板高度')}
                    <input
                      type="range"
                      min="160"
                      max="800"
                      value={preferences.height}
                      onChange={(e) =>
                        update({ height: Number(e.target.value) })
                      }
                    />
                  </label>
                </div>
              )}
              <div className="workbench-body">
                {preferences.files && (
                  <aside className="workbench-sidebar" data-pane="files">
                    <ResizeHandle
                      axis="x"
                      size={preferences.width}
                      minimum={220}
                      maximum={() =>
                        matchMedia('(max-width: 899px)').matches
                          ? Math.min(
                              640,
                              (root.current?.clientWidth || 1600) - 16,
                            )
                          : Math.min(
                              640,
                              (root.current?.clientWidth || 1600) * 0.4,
                            )
                      }
                      initial={256}
                      label={t('调整文件浏览器宽度')}
                      change={(width) => update({ width })}
                    />
                    <Explorer
                      key={`${host}:${project}`}
                      host={host}
                      project={project}
                      open={setPath}
                      upload={upload}
                      close={() => {
                        fullscreen.exit();
                        update({ files: false });
                      }}
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
                    resize={
                      <ResizeHandle
                        axis="x"
                        reverse
                        size={preferences.previewWidth}
                        minimum={280}
                        maximum={() =>
                          matchMedia('(max-width: 1279px)').matches
                            ? Math.min(
                                900,
                                (root.current?.clientWidth || 1600) - 16,
                              )
                            : Math.min(
                                900,
                                (root.current?.clientWidth || 1600) * 0.55,
                              )
                        }
                        initial={420}
                        label={t('调整文件预览宽度')}
                        change={(previewWidth) => update({ previewWidth })}
                      />
                    }
                    reference={(value) => {
                      reference(value);
                      setPath('');
                    }}
                  />
                )}
              </div>
              {terminalLoaded && (
                <div
                  className="workbench-bottom terminal-shell"
                  data-pane="terminal"
                  hidden={!terminalShown}
                >
                  <ResizeHandle
                    axis="y"
                    reverse
                    size={preferences.terminalHeight}
                    minimum={220}
                    maximum={() =>
                      Math.min(
                        900,
                        (root.current?.clientHeight || 900) -
                          (matchMedia('(max-width: 899px), (max-height: 600px)')
                            .matches
                            ? 8
                            : 220),
                      )
                    }
                    initial={360}
                    label={t('调整 Terminal 高度')}
                    change={(terminalHeight) => update({ terminalHeight })}
                  />
                  <Suspense fallback={<p role="status">{t('正在读取…')}</p>}>
                    <InteractiveTerminal
                      key={`${host}:${project}:${session}`}
                      host={host}
                      project={project}
                      session={session}
                      {...terminal}
                      prepared={
                        preparation.current?.scope === terminalScope
                          ? preparation.current.promise
                          : undefined
                      }
                      visible={terminalShown}
                      close={() => {
                        fullscreen.exit();
                        setTerminalShown(false);
                      }}
                    />
                  </Suspense>
                </div>
              )}
              {preferences.output && (
                <div
                  className="workbench-bottom output-shell"
                  data-pane="output"
                >
                  <ResizeHandle
                    axis="y"
                    reverse
                    size={preferences.height}
                    minimum={160}
                    maximum={() =>
                      Math.min(800, (root.current?.clientHeight || 900) - 180)
                    }
                    initial={240}
                    label={t('调整命令输出高度')}
                    change={(height) => update({ height })}
                  />
                  <OutputPanel
                    key={session || ''}
                    events={events}
                    chunks={chunks}
                    reading={reading}
                    read={read}
                    close={() => {
                      fullscreen.exit();
                      update({ output: false });
                    }}
                  />
                </div>
              )}
            </div>
          </PreviewContext.Provider>
        </FileContext.Provider>
      </FullscreenContext.Provider>
    </ThemeContext.Provider>
  );
}

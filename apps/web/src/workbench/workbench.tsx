import { IconButton } from '../happier/icon-button.tsx';
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
import {
  ThemeContext,
  useThemePreference,
  setThemePreference,
} from '../theme.ts';
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
  transfer,
  appearanceTarget,
  refresh,
  refreshing,
  information,
  openInformation,
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
  transfer: ReactNode;
  appearanceTarget: HTMLElement | null;
  refresh: () => void;
  refreshing: boolean;
  information?: ReactNode;
  openInformation: () => void;
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
  const theme = useThemePreference();
  const [preview, setPreview] = useState<{ path: string; scope: string }>();
  const previewScope = JSON.stringify([host, project, session]);
  const path = preview?.scope === previewScope ? preview.path : '';
  const setPath = (value: string) => {
    fullscreen.exit();
    setPreview({ path: value, scope: previewScope });
    if (value) {
      closeMenu();
      update({ files: true, output: false });
    }
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
  const terminalScope = JSON.stringify([host, project]);
  const preparation = useRef<{
    scope: string;
    time: number;
    operations: OperationClient | null | undefined;
    promise: Promise<TerminalMetadata>;
  }>(undefined);
  function prepareTerminal() {
    void loadTerminal().catch(() => {});
    if (terminalLoaded || !host || !project) return;
    if (
      preparation.current?.scope === terminalScope &&
      preparation.current.operations === terminal.operations &&
      Date.now() - preparation.current.time < 5000
    )
      return;
    const promise = queryApi(`/hosts/${host}/terminal`, {
      operation: 'info',
      projectId: project,
    });
    // A failed speculative read is shown if the user opens the terminal.
    void promise.catch(() => {});
    preparation.current = {
      scope: terminalScope,
      time: Date.now(),
      operations: terminal.operations,
      promise,
    };
  }
  const [filesLoaded, setFilesLoaded] = useState(preferences.files);
  useEffect(() => {
    if (preferences.files) setFilesLoaded(true);
  }, [preferences.files]);
  const [search, setSearch] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const fullscreen = usePaneFullscreen(root, previewScope);
  const update = (value: Partial<Preferences>) => {
    if (value.theme) setThemePreference(value.theme);
    setPreferences((old) => ({ ...old, ...value }));
  };
  useEffect(() => {
    try {
      localStorage.setItem(
        'coc-workbench-v1',
        JSON.stringify({ ...preferences, theme }),
      );
    } catch {
      /* Private browsing remains functional. */
    }
  }, [preferences, theme]);
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
    <ThemeContext.Provider value={theme}>
      <FullscreenContext.Provider value={fullscreen}>
        <FileContext.Provider value={{ host, project, root: projectRoot }}>
          <PreviewContext.Provider value={setPath}>
            <div
              className={`cw-workbench density-${preferences.density}${terminalShown ? ' terminal-visible' : ''}`}
              data-theme={theme}
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
                    <IconButton
                      icon="folder"
                      label={t('文件浏览器')}
                      aria-pressed={preferences.files && !information}
                      onClick={() => {
                        fullscreen.exit();
                        closeMenu();
                        update({
                          files: !preferences.files || !!information,
                          output: false,
                        });
                      }}
                    />
                    <IconButton
                      icon="terminal"
                      label="Terminal"
                      aria-pressed={terminalShown}
                      onPointerEnter={prepareTerminal}
                      onFocus={prepareTerminal}
                      onClick={() => {
                        prepareTerminal();
                        setTerminalLoaded(true);
                        setTerminalShown(!terminalShown);
                      }}
                    />
                    <IconButton
                      icon="activity"
                      label={t('命令输出')}
                      aria-pressed={preferences.output && !information}
                      onClick={() => {
                        fullscreen.exit();
                        closeMenu();
                        update({
                          output: !preferences.output || !!information,
                          files: false,
                        });
                      }}
                    />
                    <IconButton
                      icon="refresh"
                      label={t('刷新状态')}
                      disabled={refreshing}
                      onClick={refresh}
                    />
                    <IconButton
                      icon="info"
                      label={t('信息')}
                      aria-pressed={!!information}
                      onClick={() => {
                        fullscreen.exit();
                        openInformation();
                      }}
                    />
                  </>,
                  menuTarget,
                )}
              {appearanceTarget &&
                createPortal(
                  <div className="appearance-panel">
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
                      <IconButton
                        icon="search"
                        label={t('查找下一个')}
                        type="submit"
                      />
                    </form>

                    <IconButton
                      icon="info"
                      label={
                        attention.enabled
                          ? t('关闭页面通知')
                          : t('启用页面通知')
                      }
                      type="button"
                      aria-pressed={attention.enabled}
                      onClick={() => void attention.toggle()}
                    />
                    <small role="status">{attention.notice}</small>
                    <WorkbenchActions
                      scope={previewScope}
                      events={events}
                      chunks={chunks}
                      actions={[
                        {
                          label: t('文件浏览器'),
                          icon: 'folder',
                          run: () => {
                            closeMenu();
                            update({ files: true, output: false });
                          },
                        },
                        {
                          label: t('命令输出'),
                          icon: 'activity',
                          run: () => {
                            closeMenu();
                            update({ output: true, files: false });
                          },
                        },
                        {
                          label: 'Terminal',
                          icon: 'terminal',
                          run: () => {
                            prepareTerminal();
                            setTerminalLoaded(true);
                            setTerminalShown(true);
                          },
                        },
                        {
                          label: t('搜索已加载对话'),
                          icon: 'search',
                          run: () => {
                            requestAnimationFrame(() =>
                              root.current
                                ?.querySelector<HTMLInputElement>(
                                  '.workbench-search input',
                                )
                                ?.focus(),
                            );
                          },
                        },
                        {
                          label: t('上传 / 传输'),
                          icon: 'upload',
                          run: () => {
                            closeMenu();
                            update({ files: true, output: false });
                          },
                        },
                      ]}
                    />
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
                      {t('工作面板宽度')}
                      <input
                        type="range"
                        min="280"
                        max="900"
                        aria-label={t('工作面板宽度')}
                        value={preferences.previewWidth}
                        onChange={(e) =>
                          update({ previewWidth: Number(e.target.value) })
                        }
                      />
                    </label>
                    <label>
                      {t('Terminal 高度')}
                      <input
                        type="range"
                        min="220"
                        max="900"
                        aria-label={t('Terminal 高度')}
                        value={preferences.terminalHeight}
                        onChange={(e) =>
                          update({ terminalHeight: Number(e.target.value) })
                        }
                      />
                    </label>
                  </div>,
                  appearanceTarget,
                )}
              <div className="workbench-body">
                <div className="workbench-conversation">{children}</div>
                {filesLoaded && (
                  <aside
                    className="unified-work-panel unified-files"
                    data-pane="files"
                    hidden={!preferences.files || !!information}
                  >
                    <ResizeHandle
                      axis="x"
                      reverse
                      size={preferences.previewWidth}
                      minimum={280}
                      maximum={() =>
                        Math.min(900, (root.current?.clientWidth || 1600) - 120)
                      }
                      initial={420}
                      label={t('调整文件浏览器宽度')}
                      change={(previewWidth) => update({ previewWidth })}
                    />
                    <Explorer
                      key={`${host}:${project}`}
                      host={host}
                      project={project}
                      open={setPath}
                      transfer={transfer}
                      close={() => {
                        fullscreen.exit();
                        update({ files: false });
                      }}
                    />
                    {path && (
                      <Preview
                        key={`${host}:${project}:${path}`}
                        host={host}
                        project={project}
                        path={path}
                        resize={null}
                        close={() => setPath('')}
                        reference={(value) => {
                          reference(value);
                          setPath('');
                        }}
                      />
                    )}
                  </aside>
                )}
                {preferences.output && !information && (
                  <aside
                    className="unified-work-panel unified-output"
                    data-pane="output"
                  >
                    <ResizeHandle
                      axis="x"
                      reverse
                      size={preferences.previewWidth}
                      minimum={280}
                      maximum={() =>
                        Math.min(900, (root.current?.clientWidth || 1600) - 120)
                      }
                      initial={420}
                      label={t('调整命令输出宽度')}
                      change={(previewWidth) => update({ previewWidth })}
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
                  </aside>
                )}
                {information && (
                  <aside
                    className="unified-work-panel unified-information"
                    aria-label={t('会话详情')}
                  >
                    <header className="pane-heading">
                      <h2>{t('信息')}</h2>
                      <IconButton
                        icon="close"
                        label={t('关闭信息')}
                        onClick={closeMenu}
                      />
                    </header>
                    {information}
                  </aside>
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
                        preparation.current?.scope === terminalScope &&
                        preparation.current.operations === terminal.operations
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
            </div>
          </PreviewContext.Provider>
        </FileContext.Provider>
      </FullscreenContext.Provider>
    </ThemeContext.Provider>
  );
}

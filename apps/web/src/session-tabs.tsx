import { useCallback, useRef, useState, type ComponentType } from 'react';
import type { Session } from '../../../packages/protocol/src/index.ts';
import { t, useLanguage } from './i18n.ts';
import './session-tabs.css';

export type SessionTarget = {
  host: string;
  project?: string;
  session?: Session;
};
export type SessionPaneProps = {
  initial?: SessionTarget;
  focused?: boolean;
  workspace?: {
    open: (target: SessionTarget) => void;
    activate: (target: SessionTarget) => boolean;
    changed: (
      target: SessionTarget,
      title: string,
      navigation: boolean,
    ) => void;
  };
};
type Tab = {
  id: number;
  initial?: SessionTarget;
  target?: SessionTarget;
  title: string;
  navigation: boolean;
};

// Each tab owns a complete session controller. Hiding a tab must not dispose its
// transport, pending approval, draft, terminal, or scroll position.
export function SessionTabs({
  Pane,
}: {
  Pane: ComponentType<SessionPaneProps>;
}) {
  useLanguage();
  const next = useRef(1);
  const [tabs, setTabs] = useState<Tab[]>([
    { id: 0, title: '', navigation: true },
  ]);
  const [active, setActive] = useState(0);
  const [partner, setPartner] = useState<number>();
  const [layout, setLayout] = useState<'tabs' | 'horizontal' | 'vertical'>(
    'tabs',
  );
  const [ratio, setRatio] = useState(50);
  const area = useRef<HTMLDivElement>(null);
  const currentTabs = useRef(tabs);
  currentTabs.current = tabs;
  const activate = useCallback((target: SessionTarget) => {
    const existing =
      target.session &&
      currentTabs.current.find(
        (tab) =>
          tab.target?.host === target.host &&
          tab.target.session?.id === target.session?.id,
      );
    if (!existing) return false;
    setActive(existing.id);
    return true;
  }, []);
  const open = useCallback(
    (target: SessionTarget) => {
      if (activate(target)) return;
      const id = next.current++;
      setTabs((rows) => [
        ...rows,
        {
          id,
          initial: target,
          target,
          title: target.session?.title || '',
          navigation: true,
        },
      ]);
      if (layout !== 'tabs') setPartner(active);
      setActive(id);
    },
    [activate, active, layout],
  );
  const close = (id: number) => {
    const remaining = tabs.filter((tab) => tab.id !== id);
    if (!remaining.length) {
      const fresh = next.current++;
      const initial = {
        host: tabs.find((tab) => tab.id === id)?.target?.host || '',
      };
      setTabs([
        { id: fresh, title: '', navigation: true, initial, target: initial },
      ]);
      setActive(fresh);
    } else {
      setTabs(remaining);
      if (active === id) setActive(remaining.at(-1)!.id);
    }
    if (partner === id) setPartner(undefined);
  };
  const focused = tabs.find((tab) => tab.id === active) || tabs[0];
  const other =
    tabs.find((tab) => tab.id === partner && tab.id !== active) ||
    tabs.find((tab) => tab.id !== active);
  const split = layout !== 'tabs' && !!other;
  const ordered = split
    ? tabs
        .filter((tab) => tab.id === focused.id || tab.id === other.id)
        .map((tab) => tab.id)
    : [focused.id];
  return (
    <div
      className={`session-desktop${focused.navigation ? ' has-navigation' : ''}`}
      data-layout={layout}
    >
      <header className="session-tab-toolbar">
        <div
          role="tablist"
          aria-label={t('打开的会话')}
          className="session-tabs"
        >
          {tabs.map((tab) => (
            <div className="session-tab" key={tab.id}>
              <button
                role="tab"
                id={`session-tab-${tab.id}`}
                aria-controls={`session-pane-${tab.id}`}
                aria-selected={tab.id === active}
                tabIndex={tab.id === active ? 0 : -1}
                onClick={() => {
                  if (split && tab.id !== active) setPartner(active);
                  setActive(tab.id);
                }}
                onKeyDown={(event) => {
                  const index = tabs.indexOf(tab);
                  const target =
                    event.key === 'ArrowRight'
                      ? tabs[(index + 1) % tabs.length]
                      : event.key === 'ArrowLeft'
                        ? tabs[(index + tabs.length - 1) % tabs.length]
                        : event.key === 'Home'
                          ? tabs[0]
                          : event.key === 'End'
                            ? tabs.at(-1)
                            : undefined;
                  if (target) {
                    event.preventDefault();
                    setActive(target.id);
                    document
                      .getElementById(`session-tab-${target.id}`)
                      ?.focus();
                  }
                }}
                title={tab.target?.host}
              >
                {tab.title || t('新会话')}
              </button>
              <button
                className="session-tab-close"
                aria-label={t('关闭标签：{0}', tab.title || t('新会话'))}
                onClick={() => close(tab.id)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <button
          aria-label={t('新建会话标签')}
          onClick={() => open({ host: focused.target?.host || '' })}
        >
          ＋
        </button>
        <select
          aria-label={t('会话布局')}
          value={layout}
          onChange={(event) => setLayout(event.target.value as typeof layout)}
        >
          <option value="tabs">{t('标签页')}</option>
          <option value="horizontal">{t('水平分割（左右）')}</option>
          <option value="vertical">{t('垂直分割（上下）')}</option>
        </select>
      </header>
      <div
        className="session-pane-area"
        ref={area}
        style={
          split
            ? {
                [layout === 'horizontal'
                  ? 'gridTemplateColumns'
                  : 'gridTemplateRows']: `${ratio}fr 6px ${100 - ratio}fr`,
              }
            : undefined
        }
      >
        {tabs.map((tab) => (
          <section
            key={tab.id}
            role="tabpanel"
            id={`session-pane-${tab.id}`}
            aria-labelledby={`session-tab-${tab.id}`}
            hidden={!ordered.includes(tab.id)}
            className={`session-pane${tab.id === active ? ' focused' : ''}`}
            style={{ order: ordered.indexOf(tab.id) * 2 }}
          >
            <Pane
              initial={tab.initial}
              focused={tab.id === active}
              workspace={{
                open,
                activate,
                changed: (target, title, navigation) =>
                  setTabs((rows) =>
                    rows.map((row) =>
                      row.id === tab.id
                        ? { ...row, target, title, navigation }
                        : row,
                    ),
                  ),
              }}
            />
          </section>
        ))}
        {split && (
          <div
            className="session-divider"
            style={{ order: 1 }}
            role="separator"
            tabIndex={0}
            aria-label={t('调整会话分割比例')}
            aria-orientation={
              layout === 'horizontal' ? 'vertical' : 'horizontal'
            }
            aria-valuemin={20}
            aria-valuemax={80}
            aria-valuenow={ratio}
            onDoubleClick={() => setRatio(50)}
            onKeyDown={(event) => {
              if (
                [
                  'ArrowLeft',
                  'ArrowUp',
                  'ArrowRight',
                  'ArrowDown',
                  'Home',
                  'End',
                ].includes(event.key)
              ) {
                event.preventDefault();
                setRatio(
                  event.key === 'Home'
                    ? 20
                    : event.key === 'End'
                      ? 80
                      : Math.max(
                          20,
                          Math.min(
                            80,
                            ratio +
                              (['ArrowLeft', 'ArrowUp'].includes(event.key)
                                ? -2
                                : 2),
                          ),
                        ),
                );
              }
            }}
            onPointerDown={(event) => {
              if (event.button === 0)
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (!event.currentTarget.hasPointerCapture(event.pointerId))
                return;
              const rect = area.current!.getBoundingClientRect();
              setRatio(
                Math.max(
                  20,
                  Math.min(
                    80,
                    layout === 'horizontal'
                      ? ((event.clientX - rect.left) / rect.width) * 100
                      : ((event.clientY - rect.top) / rect.height) * 100,
                  ),
                ),
              );
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
            }}
          />
        )}
      </div>
    </div>
  );
}

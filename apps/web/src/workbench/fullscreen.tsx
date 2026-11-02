import {
  createContext,
  useContext,
  useEffect,
  useState,
  type RefObject,
} from 'react';
import { t } from '../i18n.ts';
import { useFullscreenElement } from '../fullscreen.tsx';

type Pane = 'files' | 'preview' | 'output' | 'terminal';
export const FullscreenContext = createContext<{
  pane: Pane | null;
  toggle: (pane: Pane) => void;
}>({ pane: null, toggle: () => {} });

export function FullscreenButton({ pane }: { pane: Pane }) {
  const fullscreen = useContext(FullscreenContext);
  const active = fullscreen.pane === pane;
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={() => fullscreen.toggle(pane)}
    >
      {active ? t('退出全屏') : t('全屏')}
    </button>
  );
}

// Keep the existing pane mounted: especially important for a live Terminal.
export function usePaneFullscreen(
  root: RefObject<HTMLDivElement | null>,
  scope: string,
) {
  const [pane, setPane] = useState<Pane | null>(null);
  useEffect(() => setPane(null), [scope]);
  useFullscreenElement(
    pane
      ? root.current?.querySelector<HTMLElement>(`[data-pane="${pane}"]`)
      : null,
    pane !== null,
    () => setPane(null),
  );
  return {
    pane,
    toggle: (value: Pane) => setPane((old) => (old === value ? null : value)),
    exit: () => setPane(null),
  };
}

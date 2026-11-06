import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';

export type ThemePreference = 'dark' | 'light' | 'system';
export const ThemeContext = createContext<ThemePreference | undefined>(
  undefined,
);
let memoryTheme: ThemePreference | undefined;
function storedTheme(): ThemePreference {
  if (memoryTheme) return memoryTheme;
  try {
    const theme = JSON.parse(
      localStorage.getItem('coc-workbench-v1') || '{}',
    ).theme;
    return theme === 'dark' || theme === 'light' ? theme : 'system';
  } catch {
    return 'system';
  }
}
function subscribeStorage(change: () => void) {
  window.addEventListener('storage', change);
  window.addEventListener('coc-theme-change', change);
  return () => {
    window.removeEventListener('storage', change);
    window.removeEventListener('coc-theme-change', change);
  };
}
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribeStorage, storedTheme, () => 'system');
}
export function setThemePreference(theme: ThemePreference) {
  try {
    const settings = JSON.parse(
      localStorage.getItem('coc-workbench-v1') || '{}',
    );
    localStorage.setItem(
      'coc-workbench-v1',
      JSON.stringify({ ...settings, theme }),
    );
    memoryTheme = undefined;
  } catch {
    memoryTheme = theme;
  }
  window.dispatchEvent(new Event('coc-theme-change'));
}
function subscribeSystem(change: () => void) {
  const media = matchMedia('(prefers-color-scheme: light)');
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}
export function useResolvedTheme(): 'dark' | 'light' {
  const preference = useContext(ThemeContext);
  const stored = useThemePreference();
  const light = useSyncExternalStore(
    subscribeSystem,
    () => matchMedia('(prefers-color-scheme: light)').matches,
    () => false,
  );
  const theme = preference ?? stored;
  return theme === 'system' ? (light ? 'light' : 'dark') : theme;
}

export function SiteTheme({ children }: { children: ReactNode }) {
  const theme = useResolvedTheme();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return children;
}

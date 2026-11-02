import { createContext, useContext, useSyncExternalStore } from 'react';

export type ThemePreference = 'dark' | 'light' | 'system';
export const ThemeContext = createContext<ThemePreference | undefined>(
  undefined,
);
function storedTheme(): ThemePreference {
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
  return () => window.removeEventListener('storage', change);
}
function subscribeSystem(change: () => void) {
  const media = matchMedia('(prefers-color-scheme: light)');
  media.addEventListener('change', change);
  return () => media.removeEventListener('change', change);
}
export function useResolvedTheme(): 'dark' | 'light' {
  const preference = useContext(ThemeContext);
  const stored = useSyncExternalStore<ThemePreference>(
    subscribeStorage,
    storedTheme,
    () => 'system',
  );
  const light = useSyncExternalStore(
    subscribeSystem,
    () => matchMedia('(prefers-color-scheme: light)').matches,
    () => false,
  );
  const theme = preference ?? stored;
  return theme === 'system' ? (light ? 'light' : 'dark') : theme;
}

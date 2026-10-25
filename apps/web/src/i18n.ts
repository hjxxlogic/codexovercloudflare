import { useSyncExternalStore } from 'react';
import { english } from './translations.ts';

export type Language = 'zh-CN' | 'en';
const storageKey = 'coc-language';
const listeners = new Set<() => void>();
function readLanguage(): Language {
  try {
    return localStorage.getItem(storageKey) === 'en' ? 'en' : 'zh-CN';
  } catch {
    return 'zh-CN';
  }
}
let language = readLanguage();
const patterns = Object.keys(english)
  .filter((key) => /\{\d+\}/.test(key))
  .map((key) => ({
    key,
    expression: new RegExp(
      '^' +
        key
          .split(/(\{\d+\})/)
          .map((part) =>
            /^\{\d+\}$/.test(part)
              ? '([\\s\\S]*?)'
              : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join('') +
        '$',
    ),
    slots: [...key.matchAll(/\{(\d+)\}/g)].map((match) => Number(match[1])),
  }));

/** Translate interface text only. User messages, paths and server payloads stay intact. */
export function translate(
  text: string,
  target: Language,
  ...values: unknown[]
): string {
  let format =
    target === 'en' && Object.hasOwn(english, text) ? english[text] : text;
  if (
    target === 'en' &&
    !Object.hasOwn(english, text) &&
    /\p{Script=Han}/u.test(text)
  ) {
    for (const pattern of patterns) {
      const match = pattern.expression.exec(text);
      if (!match) continue;
      const captured: string[] = [];
      pattern.slots.forEach((slot, index) => {
        captured[slot] = match[index + 1];
      });
      format = english[pattern.key].replace(
        /\{(\d+)\}/g,
        (_, index: string) => captured[Number(index)],
      );
      return format;
    }
  }
  return format.replace(/\{(\d+)\}/g, (placeholder, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : placeholder,
  );
}
export function t(text: string, ...values: unknown[]): string {
  return translate(text, language, ...values);
}
export function localeTag(): Language {
  return language;
}
function updateDocument() {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = language;
  document.title = t('远程 Codex');
}
export function setLanguage(next: Language) {
  language = next;
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    /* In-memory switching still works. */
  }
  updateDocument();
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function useLanguage(): Language {
  return useSyncExternalStore(
    subscribe,
    () => language,
    () => 'zh-CN' as Language,
  );
}
if (typeof window !== 'undefined') {
  updateDocument();
  window.addEventListener('storage', (event) => {
    if (event.key !== storageKey && event.key !== null) return;
    language = readLanguage();
    updateDocument();
    listeners.forEach((listener) => listener());
  });
}

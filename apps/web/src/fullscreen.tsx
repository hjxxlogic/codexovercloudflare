import { IconButton } from './happier/icon-button.tsx';
import { useEffect, useRef, useState } from 'react';
import { t } from './i18n.ts';

type Entry = { element: HTMLElement; exit: () => void };
const stack: Entry[] = [];
const originalInert = new Map<HTMLElement, boolean>();
let originalOverflow = '';
function focusable(element: HTMLElement) {
  return Array.from(
    element.querySelectorAll<HTMLElement>(
      'button, a[href], input, select, textarea, iframe, [tabindex]',
    ),
  ).filter(
    (node) =>
      node.tabIndex >= 0 &&
      !node.matches(':disabled') &&
      !node.closest('[inert]') &&
      node.getClientRects().length,
  );
}
function reconcile() {
  originalInert.forEach((inert, element) => {
    element.inert = inert;
  });
  originalInert.clear();
  let current = stack.at(-1)?.element;
  while (current?.parentElement) {
    for (const sibling of current.parentElement.children) {
      if (sibling !== current && sibling instanceof HTMLElement) {
        originalInert.set(sibling, sibling.inert);
        sibling.inert = true;
      }
    }
    current = current.parentElement;
    if (current === document.body) break;
  }
  document.body.style.overflow = stack.length ? 'hidden' : originalOverflow;
}
export function exitTopFullscreen(origin: HTMLElement) {
  const entry = stack.at(-1);
  if (entry?.element.contains(origin)) entry.exit();
}
function keyboard(event: KeyboardEvent) {
  const entry = stack.at(-1);
  if (!entry || event.isComposing) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopImmediatePropagation();
    entry.exit();
  } else if (event.key === 'Tab') {
    const nodes = focusable(entry.element);
    const index = nodes.indexOf(document.activeElement as HTMLElement);
    if (
      index < 0 ||
      (event.shiftKey ? index === 0 : index === nodes.length - 1)
    ) {
      event.preventDefault();
      (event.shiftKey ? nodes.at(-1) : nodes[0])?.focus();
    }
  }
}

export function useFullscreenElement(
  element: HTMLElement | null | undefined,
  active: boolean,
  exit: () => void,
) {
  const exitRef = useRef(exit);
  exitRef.current = exit;
  useEffect(() => {
    if (!element || !active) return;
    const previous = document.activeElement;
    if (!stack.length) {
      originalOverflow = document.body.style.overflow;
      document.addEventListener('keydown', keyboard, true);
    }
    const entry = { element, exit: () => exitRef.current() };
    stack.push(entry);
    reconcile();
    if (!element.contains(previous)) focusable(element)[0]?.focus();
    return () => {
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      reconcile();
      if (!stack.length)
        document.removeEventListener('keydown', keyboard, true);
      if (
        previous instanceof HTMLElement &&
        previous.isConnected &&
        !previous.closest('[inert]')
      )
        previous.focus();
    };
  }, [element, active]);
}

export function useElementFullscreen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [active, setActive] = useState(false);
  useFullscreenElement(ref.current, active, () => setActive(false));
  return { ref, active, toggle: () => setActive((value) => !value) };
}

export function ElementFullscreenButton({
  active,
  toggle,
}: {
  active: boolean;
  toggle: () => void;
}) {
  return (
    <IconButton
      icon={active ? 'minimize' : 'fullscreen'}
      label={active ? t('退出全屏') : t('全屏')}
      type="button"
      aria-pressed={active}
      onClick={toggle}
    />
  );
}

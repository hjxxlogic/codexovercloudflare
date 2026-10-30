import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type TouchEvent,
  type WheelEvent,
} from 'react';

export function useBottomRefresh(
  enabled: boolean,
  refresh: () => Promise<void>,
  identity: string,
) {
  const gesture = useRef({
    until: 0,
    consumed: false,
    wheelAt: 0,
    touchY: 0,
    touchDistance: 0,
    touch: false,
  });
  const lastRefresh = useRef(-Infinity);
  const pending = useRef(false);
  useEffect(() => {
    gesture.current.until = 0;
    gesture.current.consumed = false;
    gesture.current.wheelAt = 0;
    gesture.current.touch = false;
    lastRefresh.current = -Infinity;
  }, [enabled, identity]);
  const atBottom = (element: HTMLElement) =>
    element.scrollHeight - element.scrollTop - element.clientHeight <= 2;
  function attempt(element: HTMLElement) {
    const current = gesture.current;
    if (
      !enabled ||
      current.consumed ||
      current.until < Date.now() ||
      !atBottom(element) ||
      pending.current ||
      Date.now() - lastRefresh.current < 1000
    )
      return;
    current.consumed = true;
    lastRefresh.current = Date.now();
    pending.current = true;
    const finish = () => {
      pending.current = false;
    };
    void refresh().then(finish, finish);
  }
  function nestedCanScroll(target: EventTarget, element: HTMLElement) {
    let child = target instanceof HTMLElement ? target : null;
    while (child && child !== element) {
      if (
        child.scrollHeight - child.scrollTop - child.clientHeight > 2 &&
        ['auto', 'scroll'].includes(getComputedStyle(child).overflowY)
      )
        return true;
      child = child.parentElement;
    }
    return false;
  }
  return {
    onWheel(event: WheelEvent<HTMLDivElement>) {
      if (
        event.deltaY <= 0 ||
        nestedCanScroll(event.target, event.currentTarget)
      ) {
        gesture.current.until = 0;
        return;
      }
      const current = gesture.current;
      if (Date.now() - current.wheelAt > 300) current.consumed = false;
      current.wheelAt = Date.now();
      current.until = Date.now() + 500;
      attempt(event.currentTarget);
    },
    onTouchStart(event: TouchEvent<HTMLDivElement>) {
      gesture.current.touch = event.touches.length === 1;
      gesture.current.touchY = event.touches[0]?.clientY ?? 0;
      gesture.current.touchDistance = 0;
      gesture.current.consumed = false;
      gesture.current.until = 0;
    },
    onTouchMove(event: TouchEvent<HTMLDivElement>) {
      const current = gesture.current;
      const y = event.touches[0]?.clientY ?? current.touchY;
      const distance = current.touchY - y;
      current.touchY = y;
      current.touchDistance =
        distance > 0 ? current.touchDistance + distance : 0;
      if (
        !current.touch ||
        event.touches.length !== 1 ||
        current.touchDistance < 12 ||
        nestedCanScroll(event.target, event.currentTarget)
      ) {
        current.until = 0;
        return;
      }
      current.until = Date.now() + 1000;
      attempt(event.currentTarget);
    },
    onTouchEnd() {
      gesture.current.touch = false;
    },
    onTouchCancel() {
      gesture.current.touch = false;
      gesture.current.until = 0;
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (
        event.target !== event.currentTarget ||
        event.shiftKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !['End', 'PageDown', 'ArrowDown', ' '].includes(event.key)
      )
        return;
      if (!event.repeat) gesture.current.consumed = false;
      gesture.current.until = Date.now() + 500;
      attempt(event.currentTarget);
    },
    onScroll(event: { currentTarget: HTMLDivElement }) {
      attempt(event.currentTarget);
    },
  };
}

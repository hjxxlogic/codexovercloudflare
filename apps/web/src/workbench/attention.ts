import { useEffect, useRef, useState } from 'react';
import type { Event } from '../../../../packages/protocol/src/index.ts';
import { t } from '../i18n.ts';
export function useWorkbenchAttention(
  scope: string,
  busy: boolean,
  ready: boolean,
  approvals: string[],
  events: Event[],
) {
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState('');
  const notification = useRef<Notification | null>(null);
  let completed: Event | undefined;
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].type === 'turn/completed') {
      completed = events[index];
      break;
    }
  }
  const identity = completed
    ? `${completed.seq}:${completed.revision || 0}`
    : '';
  const signature = approvals.join('\n');
  const previous = useRef({ scope, busy, signature, identity });
  useEffect(() => {
    const title = document.title;
    return () => {
      document.title = title;
      notification.current?.close();
    };
  }, []);
  useEffect(() => {
    document.title = approvals.length
      ? `(${approvals.length}) ${t('待确认请求')} · CW`
      : busy
        ? `${t('执行中')} · CW`
        : 'CW';
    const old = previous.current;
    previous.current = { scope, busy, signature, identity };
    if (
      !enabled ||
      !ready ||
      old.scope !== scope ||
      document.visibilityState !== 'hidden' ||
      !('Notification' in window) ||
      Notification.permission !== 'granted'
    )
      return;
    const title =
      signature && signature !== old.signature
        ? t('待确认请求')
        : old.busy && !busy && identity && identity !== old.identity
          ? t('本轮结束')
          : '';
    if (title) {
      notification.current?.close();
      // No message, command, project path, or host data leaves the page.
      try {
        notification.current = new Notification(title, { tag: 'cw-attention' });
      } catch {
        setNotice(t('此浏览器不支持页面通知'));
      }
    }
  }, [scope, busy, ready, signature, identity, enabled]);
  async function toggle() {
    if (enabled) {
      notification.current?.close();
      setEnabled(false);
      return;
    }
    if (!('Notification' in window)) {
      setNotice(t('此浏览器不支持页面通知'));
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setEnabled(permission === 'granted');
      setNotice(
        permission === 'granted'
          ? t('页面通知已启用；关闭页面后不再提醒。')
          : t('通知权限未授予'),
      );
    } catch {
      setNotice(t('此浏览器不支持页面通知'));
    }
  }
  return { enabled, notice, toggle };
}

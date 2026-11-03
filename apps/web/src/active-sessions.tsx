import { useEffect, useState } from 'react';
import type { Session } from '../../../packages/protocol/src/index.ts';
import { api } from './api.ts';
import { t, localeTag } from './i18n.ts';

export type SessionHost = { id: string; name?: string };

export async function loadActiveSessions(hostId: string, signal: AbortSignal) {
  const sessions: Session[] = [];
  let cursor: string | null = null;
  do {
    const page: { data: Session[]; nextCursor: string | null } = await api(
      `/sessions?paged=true&mine=true&state=ready&hostId=${encodeURIComponent(hostId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      undefined,
      signal,
    );
    sessions.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return sessions;
}

export function ActiveSessions({
  hosts,
  revision,
  onContinue,
}: {
  hosts: SessionHost[];
  revision: number;
  onContinue: (hostId: string, session: Session) => void;
}) {
  const [rows, setRows] = useState<{ host: SessionHost; session: Session }[]>(
    [],
  );
  const [failed, setFailed] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const scope = JSON.stringify(hosts.map(({ id, name }) => ({ id, name })));
  useEffect(() => {
    const controller = new AbortController();
    const available: SessionHost[] = JSON.parse(scope);
    setLoading(true);
    setRows([]);
    setFailed([]);
    void Promise.allSettled(
      available.map(async (host) => ({
        host,
        sessions: await loadActiveSessions(host.id, controller.signal),
      })),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setRows(
        results
          .flatMap((result) =>
            result.status === 'fulfilled'
              ? result.value.sessions.map((session) => ({
                  host: result.value.host,
                  session,
                }))
              : [],
          )
          .sort(
            (a, b) =>
              (b.session.updatedAt || b.session.createdAt) -
              (a.session.updatedAt || a.session.createdAt),
          ),
      );
      setFailed(
        results.flatMap((result, index) =>
          result.status === 'rejected'
            ? [available[index].name || available[index].id]
            : [],
        ),
      );
      setLoading(false);
    });
    return () => controller.abort();
  }, [scope, revision, retry]);
  return (
    <section className="welcome-sessions" aria-label={t('进行中的会话')}>
      <h3>{t('进行中的会话')}</h3>
      <button disabled={loading} onClick={() => setRetry((value) => value + 1)}>
        {t('刷新会话')}
      </button>
      {loading && <p role="status">{t('正在加载…')}</p>}
      {!loading && !rows.length && !failed.length && (
        <p>{t('当前邮箱没有进行中的会话。')}</p>
      )}
      {failed.length > 0 && (
        <p role="alert">
          {t('以下服务器的会话读取失败，请刷新重试：{0}', failed.join('、'))}
        </p>
      )}
      {rows.map(({ host, session }) => (
        <button
          className="session"
          key={session.id}
          onClick={() => onContinue(host.id, session)}
        >
          <span>{session.title || t('进行中的对话')}</span>
          <small>
            {host.name || host.id} · {session.projectId}
          </small>
          <small>
            {new Date(session.updatedAt || session.createdAt).toLocaleString(
              localeTag(),
            )}{' '}
            · {t('恢复并继续')}
          </small>
        </button>
      ))}
    </section>
  );
}

import { useEffect, useState } from 'react';
import type { Session } from '../../../packages/protocol/src/index.ts';
import { api } from './api.ts';
import { t, localeTag } from './i18n.ts';
import {
  activeSession,
  openSessionStates,
  SessionStatus,
  sessionPriority,
} from './session-status.tsx';

export type SessionHost = { id: string; name?: string };
type CatalogSession = Session & { heads?: unknown };

export async function loadActiveSessions(
  hostId: string,
  signal: AbortSignal,
  mine = true,
) {
  const sessions: CatalogSession[] = [];
  for (const state of openSessionStates) {
    let cursor: string | null = null;
    const seen = new Set<string>();
    do {
      const page: { data: CatalogSession[]; nextCursor: string | null } =
        await api(
          `/sessions?paged=true${mine ? '&mine=true' : ''}&state=${state}&hostId=${encodeURIComponent(hostId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          undefined,
          signal,
        );
      sessions.push(...page.data);
      cursor = page.nextCursor;
      if (cursor) {
        if (seen.has(cursor)) throw new Error('会话目录返回重复分页标记');
        seen.add(cursor);
      }
    } while (cursor);
  }
  return mergeSessionCatalog(sessions).filter(activeSession);
}

export function mergeSessionCatalog(...pages: Session[][]) {
  const rows = new Map<string, CatalogSession>();
  for (const session of pages.flat()) {
    const previous = rows.get(session.id);
    const timestamp = session.updatedAt || session.createdAt;
    const previousTimestamp = previous?.updatedAt || previous?.createdAt || 0;
    if (
      !previous ||
      session.deleted ||
      (!previous.deleted &&
        (timestamp > previousTimestamp ||
          (timestamp === previousTimestamp &&
            (!activeSession(session) || activeSession(previous)))))
    )
      rows.set(session.id, session);
  }
  return [...rows.values()];
}

export async function loadSessionCatalog(hostId: string, signal: AbortSignal) {
  const [page, active] = await Promise.all([
    api(
      `/sessions?paged=true&hostId=${encodeURIComponent(hostId)}`,
      undefined,
      signal,
    ) as Promise<{ data: CatalogSession[]; nextCursor: string | null }>,
    loadActiveSessions(hostId, signal, false),
  ]);
  return {
    data: mergeSessionCatalog(page.data, active),
    nextCursor: page.nextCursor,
  };
}

export function ActiveSessions({
  hosts,
  revision,
  onContinue,
  mine = true,
}: {
  hosts: SessionHost[];
  revision: number;
  onContinue: (hostId: string, session: Session) => void;
  mine?: boolean;
}) {
  const [rows, setRows] = useState<
    { host: SessionHost; session: Session; projectName?: string }[]
  >([]);
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
      available.map(async (host) => {
        const [sessions, projects]: [
          Session[],
          { id: string; name: string }[],
        ] = await Promise.all([
          loadActiveSessions(host.id, controller.signal, mine),
          api(
            `/hosts/${encodeURIComponent(host.id)}/projects`,
            undefined,
            controller.signal,
          ).catch(() => []),
        ]);
        return { host, sessions, projects };
      }),
    ).then((results) => {
      if (controller.signal.aborted) return;
      setRows(
        results
          .flatMap((result) =>
            result.status === 'fulfilled'
              ? result.value.sessions.map((session) => ({
                  host: result.value.host,
                  session,
                  projectName: result.value.projects.find(
                    (project) => project.id === session.projectId,
                  )?.name,
                }))
              : [],
          )
          .sort(
            (a, b) =>
              sessionPriority(a.session) - sessionPriority(b.session) ||
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
  }, [scope, revision, retry, mine]);
  return (
    <section className="welcome-sessions" aria-label={t('进行中的会话')}>
      <h3>{t('进行中的会话')}</h3>
      <button disabled={loading} onClick={() => setRetry((value) => value + 1)}>
        {t('刷新会话')}
      </button>
      {loading && <p role="status">{t('正在加载…')}</p>}
      {!loading && !rows.length && !failed.length && (
        <p>{t(mine ? '当前邮箱没有进行中的会话。' : '当前没有活动会话。')}</p>
      )}
      {failed.length > 0 && (
        <p role="alert">
          {t('以下服务器的会话读取失败，请刷新重试：{0}', failed.join('、'))}
        </p>
      )}
      {rows.map(({ host, session, projectName }) => (
        <button
          className="session welcome-active-session"
          key={session.id}
          onClick={() => onContinue(host.id, session)}
        >
          <span className="welcome-session-title">
            <span>{session.title || t('进行中的对话')}</span>
            <SessionStatus session={session} />
          </span>
          <small>
            {host.name || host.id}
            {projectName ? ` · ${projectName}` : ''}
          </small>
          <small>
            {new Date(session.updatedAt || session.createdAt).toLocaleString(
              localeTag(),
            )}{' '}
            · {t('继续对话')}
          </small>
        </button>
      ))}
    </section>
  );
}

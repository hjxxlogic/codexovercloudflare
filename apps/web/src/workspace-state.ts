import {
  sessionSchema,
  type Session,
  type Project,
} from '../../../packages/protocol/src/index.ts';

const lastHostKey = 'coc:last-host';

// This is only a routing hint. Authentication must validate it before opening a cache.
export function lastHost(): string {
  try {
    return localStorage.getItem(lastHostKey) || '';
  } catch {
    return '';
  }
}
export function rememberHost(host: string) {
  try {
    if (host) localStorage.setItem(lastHostKey, host);
    else localStorage.removeItem(lastHostKey);
  } catch {
    // Unavailable browser storage must not prevent online use.
  }
}

export type WorkspaceState = {
  projectId: string;
  session?: Session;
};

export function restoreWorkspace(
  value: unknown,
  host: string,
  projects: Project[],
  sessions: Session[],
): WorkspaceState {
  const saved =
    value && typeof value === 'object'
      ? (value as Partial<WorkspaceState>)
      : {};
  const projectId = projects.some((p) => p.id === saved.projectId)
    ? saved.projectId!
    : projects[0]?.id || '';
  const parsed = sessionSchema.safeParse(saved.session);
  const session = parsed.success
    ? sessions.find((s) => s.id === parsed.data.id) || parsed.data
    : undefined;
  return {
    projectId,
    session:
      session?.id.startsWith(host + '~') &&
      session.projectId === projectId &&
      session.mode === 'web'
        ? session
        : undefined,
  };
}

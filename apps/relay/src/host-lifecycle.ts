import { AppError } from '../../../packages/protocol/src/index.ts';
import { D1State, type StateStorage } from './state.ts';

export const HOST_STATE_KEY = '@hostState';
export const HOST_IDLE_MS = 60_000;
const PAGE_SIZE = 64;

export type HostLocation = {
  version: 1;
  owner: 'do' | 'd1';
  token: string;
};
type LocalState = {
  version: 1;
  hostId: string;
  token: string;
  source: 'local' | 'd1';
  phase:
    | 'claim'
    | 'restore-clear'
    | 'restore-copy'
    | 'active'
    | 'archive-clear'
    | 'archive-copy'
    | 'publish';
  after?: string;
  idleAt?: number;
  notificationRevision?: number;
};

// The local marker is written BEFORE claiming ownership. The D1 location is
// published only AFTER a complete archive. Never infer authority from presence.
export class HostLifecycle {
  readonly archive: D1State;
  constructor(
    private local: StateStorage & { deleteAll(): Promise<unknown> },
    db: D1Database,
    private hostId: string,
  ) {
    this.archive = new D1State(db, 'host:' + hostId);
  }
  private unavailable(): never {
    throw new AppError(
      'STATE_UNAVAILABLE',
      'Host state ownership is inconsistent; restore the original storage',
      503,
    );
  }
  private save(state: LocalState) {
    return this.local.put(HOST_STATE_KEY, state);
  }
  // Called before exposing local state. Concurrent callers share the Host's
  // prepare promise. Pages are resumable; no 30-second concurrency gate spans
  // the entire remote copy, and no request can use a partial restore.
  async activate(activity = true) {
    let state = await this.local.get<LocalState>(HOST_STATE_KEY);
    if (state && (state.version !== 1 || state.hostId !== this.hostId))
      this.unavailable();
    if (!state) {
      const records = await this.archive.getMany(['@migrated', '@location']);
      const location = records.get('@location') as HostLocation | undefined;
      if (location && location.version !== 1) this.unavailable();
      if (location?.owner === 'do') this.unavailable();
      state = {
        version: 1,
        hostId: this.hostId,
        token: crypto.randomUUID(),
        source: records.has('@migrated') ? 'd1' : 'local',
        phase: 'claim',
        notificationRevision: (await this.local.get<number>('revision')) || 0,
      };
      await this.save(state);
    }
    if (state.phase === 'publish' && activity) {
      const location = await this.archive.get<HostLocation>('@location');
      if (location?.token !== state.token) this.unavailable();
      if (location.owner === 'd1') {
        // An offline acknowledgement may already have changed the archive.
        // Reclaim and restore it; retaining the old local copy resurrects data.
        state = {
          ...state,
          token: crypto.randomUUID(),
          source: 'd1',
          phase: 'claim',
        };
      } else state = { ...state, phase: 'active' };
      await this.save(state);
    }
    if (activity && state.phase.startsWith('archive-')) {
      state = { ...state, phase: 'active', after: undefined };
      await this.save(state);
    }
    if (state.phase === 'claim') {
      await this.archive.transaction(async (tx) => {
        const location = await tx.get<HostLocation>('@location');
        if (location?.owner === 'do' && location.token !== state!.token)
          this.unavailable();
        await tx.put('@location', {
          version: 1,
          owner: 'do',
          token: state!.token,
        } satisfies HostLocation);
        if (!(await tx.get('@migrated')))
          await tx.put('@migrated', { version: 2, at: Date.now() });
      });
      state = {
        ...state,
        phase: state.source === 'd1' ? 'restore-clear' : 'active',
        after: undefined,
      };
      await this.save(state);
    }
    if (state.phase === 'restore-clear') {
      const location = await this.archive.get<HostLocation>('@location');
      if (location?.owner !== 'do' || location.token !== state.token)
        this.unavailable();
      for (;;) {
        const page = await this.local.list({ limit: PAGE_SIZE });
        const keys = [...page.keys()].filter((key) => key !== HOST_STATE_KEY);
        if (keys.length) await this.local.delete(keys);
        if (page.size < PAGE_SIZE) break;
      }
      state = { ...state, phase: 'restore-copy', after: undefined };
      await this.save(state);
    }
    while (state.phase === 'restore-copy') {
      const location = await this.archive.get<HostLocation>('@location');
      if (location?.owner !== 'do' || location.token !== state.token)
        this.unavailable();
      const page: Map<string, any> = await this.archive.list({
        startAfter: state.after,
        limit: PAGE_SIZE,
      });
      const records = Object.fromEntries(
        [...page].filter(([key]) => !key.startsWith('@')),
      );
      state = {
        ...state,
        after: [...page.keys()].at(-1),
        phase: page.size < PAGE_SIZE ? 'active' : 'restore-copy',
      };
      if (state.phase === 'active') {
        records.revision = Math.max(
          state.notificationRevision || 0,
          (records.revision as number | undefined) ||
            (await this.local.get<number>('revision')) ||
            0,
        );
      }
      await this.local.put({ ...records, [HOST_STATE_KEY]: state });
    }
    if (activity && state.idleAt !== undefined)
      await this.save({ ...state, idleAt: undefined });
    return state.phase === 'active';
  }
  async idle() {
    const state = await this.local.get<LocalState>(HOST_STATE_KEY);
    if (!state) return;
    const at =
      state.phase === 'active'
        ? (state.idleAt ?? Date.now() + HOST_IDLE_MS)
        : Date.now() + 1000;
    if (state.idleAt === undefined) await this.save({ ...state, idleAt: at });
    const alarm = await this.local.getAlarm();
    if (alarm === null || alarm > at) await this.local.setAlarm(at);
  }
  // Caller holds a concurrency gate for ONE bounded page, after checking that
  // there are no sockets, requests, incoming frames or outstanding forwards.
  // A subsequent request cancels the copy and keeps local state authoritative.
  async archivePage(): Promise<'waiting' | 'pending' | 'archived'> {
    let state = await this.local.get<LocalState>(HOST_STATE_KEY);
    if (!state) return 'archived';
    if (state.phase === 'active') {
      if (state.idleAt === undefined || state.idleAt > Date.now())
        return 'waiting';
      state = { ...state, phase: 'archive-clear', after: undefined };
      await this.save(state);
    }
    const location = await this.archive.get<HostLocation>('@location');
    if (
      location?.version !== 1 ||
      location.token !== state.token ||
      (state.phase !== 'publish' && location.owner !== 'do')
    )
      this.unavailable();
    if (state.phase === 'archive-clear') {
      const page: Map<string, any> = await this.archive.list({
        startAfter: state.after,
        limit: PAGE_SIZE,
      });
      const keys = [...page.keys()].filter(
        (key) => !['@location', '@migrated'].includes(key),
      );
      if (keys.length) await this.archive.delete(keys);
      state = {
        ...state,
        after: page.size < PAGE_SIZE ? undefined : [...page.keys()].at(-1),
        phase: page.size < PAGE_SIZE ? 'archive-copy' : 'archive-clear',
      };
      await this.save(state);
      return 'pending';
    }
    if (state.phase === 'archive-copy') {
      const page = await this.local.list({
        startAfter: state.after,
        limit: PAGE_SIZE,
      });
      const records = Object.fromEntries(
        [...page].filter(([key]) => !key.startsWith('@')),
      );
      if (Object.keys(records).length) await this.archive.put(records);
      state = {
        ...state,
        after: [...page.keys()].at(-1),
        phase: page.size < PAGE_SIZE ? 'publish' : 'archive-copy',
      };
      await this.save(state);
      return 'pending';
    }
    if (state.phase === 'publish') {
      await this.archive.transaction(async (tx) => {
        const location = await tx.get<HostLocation>('@location');
        if (location?.token !== state!.token) this.unavailable();
        await tx.put('@location', {
          ...location,
          owner: 'd1',
        } satisfies HostLocation);
      });
      // A crash between publish and deleteAll is recognized by activate().
      await this.local.deleteAll();
      return 'archived';
    }
    this.unavailable();
  }
}

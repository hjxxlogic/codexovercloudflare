import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_IDLE_MS,
  HOST_STATE_KEY,
  HostLifecycle,
} from '../apps/relay/src/host-lifecycle.ts';
import { D1State } from '../apps/relay/src/state.ts';
import { d1Receipt, collectIdleState } from '../apps/relay/src/host-state.ts';
import type { Auth, Env } from '../apps/relay/src/common.ts';
import { SqliteD1 } from './helpers/d1-state.ts';
import { MemoryStorage } from './helpers/do-state.ts';

const databases: SqliteD1[] = [];
function harness() {
  const db = new SqliteD1();
  databases.push(db);
  const local = Object.assign(new MemoryStorage(), {
    deleteAll: vi.fn(async () => {
      local.values.clear();
      local.alarm = null;
    }),
  });
  const create = () => new HostLifecycle(local, db.binding(), 'one');
  const lifecycle = create();
  const archive = new D1State(db.binding(), 'host:one');
  const env = { STATE_BACKEND: 'd1', STATE_DB: db.binding() } as Env;
  return { db, local, lifecycle, archive, env, create };
}
async function finish(lifecycle: HostLifecycle) {
  for (let i = 0; i < 30; i++) {
    if ((await lifecycle.archivePage()) === 'archived') return;
  }
  throw new Error('Archive did not finish within bounded pages');
}
async function idle(h: ReturnType<typeof harness>) {
  await h.lifecycle.idle();
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + HOST_IDLE_MS + 1);
}
afterEach(() => {
  vi.useRealTimers();
  for (const db of databases.splice(0)) db.sqlite.close();
});

describe('active DO / inactive D1 authority', () => {
  it('keeps active state local, survives reconstruction and archives only after sustained idle', async () => {
    const h = harness();
    await h.local.put({
      agentEpoch: 7,
      'lease:session': { epoch: 9, active: false },
      presence: { connected: 0 },
    });
    await h.lifecycle.activate();
    expect(await h.archive.get('@location')).toMatchObject({ owner: 'do' });
    expect(await h.archive.get('agentEpoch')).toBeUndefined();
    const calls = vi.spyOn(h.db, 'prepare');
    await h.create().activate();
    await h.local.put('agentEpoch', 8);
    await h.lifecycle.idle();
    expect(await h.lifecycle.archivePage()).toBe('waiting');
    expect(calls).not.toHaveBeenCalled();
    expect(h.local.deleteAll).not.toHaveBeenCalled();
    await idle(h);
    await finish(h.create());
    expect(await h.archive.get('agentEpoch')).toBe(8);
    expect(await h.archive.get('@location')).toMatchObject({ owner: 'd1' });
    expect(h.local.deleteAll).toHaveBeenCalledOnce();
    await h.create().activate();
    expect(await h.local.get('agentEpoch')).toBe(8);
    expect(await h.local.get('lease:session')).toEqual({
      epoch: 9,
      active: false,
    });
  });
  it('restores currently deployed D1 state, replacing stale local records while preserving notification order', async () => {
    const h = harness();
    await h.archive.put({
      '@migrated': true,
      agentEpoch: 10,
      revision: 2,
      'lease:session': { epoch: 20, active: false },
    });
    await h.local.put({ agentEpoch: 1, revision: 30, stale: 'old DO copy' });
    await h.lifecycle.activate();
    expect(await h.local.get('agentEpoch')).toBe(10);
    expect(await h.local.get('revision')).toBe(30);
    expect(await h.local.get('stale')).toBeUndefined();
    expect(await h.archive.get('@location')).toMatchObject({ owner: 'do' });
  });
  it('resumes an interrupted restore and never uses the partially restored state', async () => {
    const h = harness();
    await h.archive.put({
      '@migrated': true,
      ...Object.fromEntries(
        Array.from({ length: 140 }, (_, i) => [
          'lease:' + String(i).padStart(3, '0'),
          { epoch: i + 1 },
        ]),
      ),
    });
    const write = h.local.put.bind(h.local);
    let pages = 0;
    const fault = vi
      .spyOn(h.local, 'put')
      .mockImplementation(async (key, value) => {
        if (typeof key === 'object' && 'lease:063' in key && ++pages === 1)
          throw new Error('Interrupted restore');
        return write(key, value);
      });
    await expect(h.lifecycle.activate()).rejects.toThrow('Interrupted restore');
    expect((await h.local.get<any>(HOST_STATE_KEY)).phase).toBe('restore-copy');
    fault.mockRestore();
    await h.create().activate();
    expect((await h.local.list({ prefix: 'lease:' })).size).toBe(140);
    expect(await h.local.get('lease:139')).toEqual({ epoch: 140 });
  });
  it('cancels an incomplete archive on new activity and replaces it with a complete fresh snapshot later', async () => {
    const h = harness();
    await h.lifecycle.activate();
    await h.local.put({
      ...Object.fromEntries(
        Array.from({ length: 140 }, (_, i) => [
          'data:' + String(i).padStart(3, '0'),
          i,
        ]),
      ),
      presence: { connected: 0 },
    });
    await idle(h);
    expect(await h.lifecycle.archivePage()).toBe('pending');
    expect(await h.lifecycle.archivePage()).toBe('pending');
    await h.create().activate();
    await h.local.put('data:000', 'new');
    await h.local.delete('data:001');
    expect(await h.archive.get('@location')).toMatchObject({ owner: 'do' });
    expect(h.local.deleteAll).not.toHaveBeenCalled();
    await idle(h);
    await finish(h.create());
    expect(await h.archive.get('data:000')).toBe('new');
    expect(await h.archive.get('data:001')).toBeUndefined();
    expect((await h.archive.list({ prefix: 'data:' })).size).toBe(139);
  });
  it('keeps local state authoritative when an archive write fails and can resume after reconstruction', async () => {
    const h = harness();
    await h.lifecycle.activate();
    await h.local.put({ agentEpoch: 42, presence: { connected: 0 } });
    await idle(h);
    await h.lifecycle.archivePage();
    h.db.failBatch = () => true;
    await expect(h.lifecycle.archivePage()).rejects.toThrow('Injected');
    expect(h.local.deleteAll).not.toHaveBeenCalled();
    expect(await h.local.get('agentEpoch')).toBe(42);
    expect(await h.archive.get('@location')).toMatchObject({ owner: 'do' });
    h.db.failBatch = undefined;
    await finish(h.create());
    expect(await h.archive.get('agentEpoch')).toBe(42);
  });
  it('does not resurrect a receipt acknowledged after publish but before local deletion', async () => {
    const h = harness();
    await h.lifecycle.activate();
    await h.local.put({
      presence: { connected: 0 },
      'operation:one': {
        state: 'completed',
        auth: { hash: 'owner' },
        expires: Date.now() + 300000,
        result: 7,
      },
    });
    await idle(h);
    await h.lifecycle.archivePage();
    await h.lifecycle.archivePage();
    h.local.deleteAll.mockRejectedValueOnce(new Error('Interrupted cleanup'));
    await expect(h.lifecycle.archivePage()).rejects.toThrow(
      'Interrupted cleanup',
    );
    expect(await h.archive.get('@location')).toMatchObject({ owner: 'd1' });
    await d1Receipt(h.env, 'one', 'one', { hash: 'owner' } as Auth, true);
    expect(await h.archive.get('operation:one')).toBeUndefined();
    await h.create().activate();
    expect(await h.local.get('operation:one')).toBeUndefined();
  });
  it('routes live receipts to DO and prevents offline GC from deleting active snapshots', async () => {
    const h = harness();
    await h.archive.put({
      '@migrated': true,
      presence: { connected: 0 },
      'operation:old': {
        auth: { hash: 'owner' },
        expires: Date.now() - 1,
        state: 'completed',
      },
    });
    await h.lifecycle.activate();
    expect(
      await d1Receipt(h.env, 'one', 'old', { hash: 'owner' } as Auth, false),
    ).toBeUndefined();
    expect(
      await d1Receipt(h.env, 'one', 'old', { hash: 'owner' } as Auth, true),
    ).toBeUndefined();
    await collectIdleState(h.env);
    expect(await h.archive.get('operation:old')).toBeDefined();
  });
  it('rechecks ownership when an offline acknowledgement races activation', async () => {
    const h = harness();
    await h.archive.put({
      '@migrated': true,
      presence: { connected: 0 },
      'operation:one': {
        auth: { hash: 'owner' },
        expires: Date.now() + 300000,
        state: 'completed',
      },
    });
    h.db.beforeBatch = async () => {
      h.db.beforeBatch = undefined;
      await h.lifecycle.activate();
    };
    expect(
      await d1Receipt(h.env, 'one', 'one', { hash: 'owner' } as Auth, true),
    ).toBeUndefined();
    expect(await h.local.get('operation:one')).toBeDefined();
  });
  it('fails closed if local authoritative storage is missing instead of restoring a stale archive', async () => {
    const h = harness();
    await h.archive.put({
      '@migrated': true,
      '@location': { version: 1, owner: 'do', token: 'lost' },
      agentEpoch: 1,
    });
    await expect(h.lifecycle.activate()).rejects.toMatchObject({
      code: 'STATE_UNAVAILABLE',
    });
    expect(await h.local.get('agentEpoch')).toBeUndefined();
  });
});

import { AppError } from '../../../packages/protocol/src/index.ts';
import { D1State, type StateStorage } from './state.ts';

export const DO_STATE_KEY = '@doState';
export function nativeState(env: { STATE_BACKEND?: string }) {
  return env.STATE_BACKEND === 'do';
}

// Only the migration release reads D1. All requests (including former direct
// reads/acks) are routed through the owning DO before this copy starts.
export async function restoreRegistry(local: StateStorage, db?: D1Database) {
  if (await local.get(DO_STATE_KEY)) return;
  const migrated = await local.get('@d1Migrated');
  if (migrated && !db)
    throw new AppError(
      'STATE_MIGRATED',
      'Restore the original D1 binding for migration',
      503,
    );
  const source = db ? new D1State(db, 'registry') : undefined;
  if (source && (await source.get('@migrated'))) {
    let cursor = await local.get<string>('@doCursor');
    if (cursor === undefined) {
      // A partially migrated Registry must never expose stale authorizations.
      for (;;) {
        const keys = [...(await local.list({ limit: 64 })).keys()].filter(
          (key) => key !== '@d1Migrated',
        );
        if (!keys.length) break;
        await local.delete(keys);
      }
    }
    for (;;) {
      const page = await source.list({ startAfter: cursor, limit: 64 });
      if (!page.size) break;
      cursor = [...page.keys()].at(-1)!;
      const records = Object.fromEntries(
        [...page].filter(([key]) => !key.startsWith('@')),
      );
      await local.put({ ...records, '@doCursor': cursor });
      if (page.size < 64) break;
    }
  } else if (migrated) {
    throw new AppError('STATE_MIGRATED', 'Original D1 state is missing', 503);
  }
  await local.transaction(async (tx) => {
    await tx.put(DO_STATE_KEY, { version: 1 });
    await tx.delete('@doCursor');
  });
}

import { D1State, hasAutomaticExpiry, type StateStorage } from './state.ts';
// This hint only skips reads of a durable, completed migration. Hibernation
// discards it safely; unfinished migrations always use their persisted cursor.
const migrated = new WeakSet<StateStorage>();

// One sorted queue per object. Permanent credentials never enter this queue.
export async function expireAt(storage: StateStorage, key: string, at: number) {
  if (!Number.isSafeInteger(at) || at === Number.MAX_SAFE_INTEGER) return;
  // D1 commits these indexes with the record. Only schedule the local alarm;
  // rewriting the same index creates needless scope conflicts and latency.
  if (!(storage instanceof D1State && hasAutomaticExpiry(key)))
    await storage.put(`due:${String(at).padStart(16, '0')}:${key}`, {
      key,
      at,
    });
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > at) await storage.setAlarm(at);
}
export async function nextExpiry(storage: StateStorage) {
  const first = await storage.list<{ at: number }>({
    prefix: 'due:',
    limit: 1,
  });
  const migration = await storage.get<{ pending?: boolean }>('expiryMigration');
  const at = migration?.pending ? Date.now() : first.values().next().value?.at;
  if (at !== undefined) await storage.setAlarm(Math.max(Date.now(), at));
  else await storage.deleteAlarm();
}
// Old installations are indexed a bounded page at a time, including offline tickets.
export async function migrateExpiry(storage: StateStorage, prefixes: string[]) {
  if (migrated.has(storage)) return;
  const state = await storage.get<{ prefix: number; after?: string }>(
    'expiryMigration',
  );
  // New objects have no legacy records to migrate. A status read must not
  // create a database just to persist an empty migration marker. New expiring
  // records are indexed by expireAt(), even after this in-memory fast path.
  if (!state && !(await storage.list({ limit: 1 })).size) {
    migrated.add(storage);
    return;
  }
  if (state?.prefix === prefixes.length) {
    migrated.add(storage);
    return;
  }
  const cursor = state || { prefix: 0 };
  const records = await storage.list<any>({
    prefix: prefixes[cursor.prefix],
    startAfter: cursor.after,
    limit: 64,
  });
  const indexes: Record<string, unknown> = {};
  let earliest = Number.MAX_SAFE_INTEGER;
  for (const [key, value] of records) {
    const at = value.expires ?? value.until;
    if (Number.isSafeInteger(at) && at < Number.MAX_SAFE_INTEGER) {
      indexes[`due:${String(at).padStart(16, '0')}:${key}`] = { key, at };
      earliest = Math.min(earliest, at);
    }
  }
  if (Object.keys(indexes).length) {
    await storage.put(indexes);
    const alarm = await storage.getAlarm();
    if (alarm === null || alarm > earliest) await storage.setAlarm(earliest);
  }
  const after = records.size === 64 ? [...records.keys()].at(-1) : undefined;
  await storage.put('expiryMigration', {
    prefix: cursor.prefix + (after ? 0 : 1),
    pending: !!after || cursor.prefix + 1 < prefixes.length,
    ...(after ? { after } : {}),
  });
  if (!after && cursor.prefix + 1 === prefixes.length) migrated.add(storage);
  if (after || cursor.prefix + 1 < prefixes.length) {
    const alarm = await storage.getAlarm();
    if (alarm === null || alarm > Date.now())
      await storage.setAlarm(Date.now());
  }
}
export async function dueEntries(storage: StateStorage) {
  const entries = await storage.list<{ key: string; at: number }>({
    prefix: 'due:',
    end: `due:${String(Date.now() + 1).padStart(16, '0')}:`,
    limit: storage instanceof D1State ? 4 : 64,
  });
  return new Map([...entries].filter(([, value]) => value.at <= Date.now()));
}

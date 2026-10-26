// One sorted queue per object. Permanent credentials never enter this queue.
export async function expireAt(
  storage: DurableObjectStorage,
  key: string,
  at: number,
) {
  if (!Number.isSafeInteger(at) || at === Number.MAX_SAFE_INTEGER) return;
  await storage.put(`due:${String(at).padStart(16, '0')}:${key}`, { key, at });
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > at) await storage.setAlarm(at);
}
export async function nextExpiry(storage: DurableObjectStorage) {
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
export async function migrateExpiry(
  storage: DurableObjectStorage,
  prefixes: string[],
) {
  const state = await storage.get<{ prefix: number; after?: string }>(
    'expiryMigration',
  );
  if (state?.prefix === prefixes.length) return;
  const cursor = state || { prefix: 0 };
  const records = await storage.list<any>({
    prefix: prefixes[cursor.prefix],
    startAfter: cursor.after,
    limit: 64,
  });
  for (const [key, value] of records) {
    const at = value.expires ?? value.until;
    if (typeof at === 'number') await expireAt(storage, key, at);
  }
  const after = records.size === 64 ? [...records.keys()].at(-1) : undefined;
  await storage.put('expiryMigration', {
    prefix: cursor.prefix + (after ? 0 : 1),
    pending: !!after || cursor.prefix + 1 < prefixes.length,
    ...(after ? { after } : {}),
  });
  if (after || cursor.prefix + 1 < prefixes.length) {
    const alarm = await storage.getAlarm();
    if (alarm === null || alarm > Date.now())
      await storage.setAlarm(Date.now());
  }
}
export async function dueEntries(storage: DurableObjectStorage) {
  const entries = await storage.list<{ key: string; at: number }>({
    prefix: 'due:',
    end: `due:${String(Date.now() + 1).padStart(16, '0')}:`,
    limit: 64,
  });
  return new Map([...entries].filter(([, value]) => value.at <= Date.now()));
}

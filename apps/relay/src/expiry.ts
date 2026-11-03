import { AppError } from '../../../packages/protocol/src/index.ts';
import type { StateStorage } from './state.ts';
// One sorted queue per object. Permanent credentials never enter this queue.
export async function expireAt(storage: StateStorage, key: string, at: number) {
  if (!Number.isSafeInteger(at) || at === Number.MAX_SAFE_INTEGER) return;
  await storage.put(`due:${String(at).padStart(16, '0')}:${key}`, { key, at });
  const alarm = await storage.getAlarm();
  if (alarm === null || alarm > at) await storage.setAlarm(at);
}
export async function nextExpiry(storage: StateStorage) {
  const first = await storage.list<{ at: number }>({
    prefix: 'due:',
    limit: 1,
  });
  const at = first.values().next().value?.at;
  if (at !== undefined) await storage.setAlarm(Math.max(Date.now(), at));
  else await storage.deleteAlarm();
}
export async function requireCurrentExpiry(storage: StateStorage) {
  const state = await storage.get<{ pending?: boolean }>('expiryMigration');
  // Completed indexes already use the current layout; no scan or conversion is needed.
  if (state !== undefined && state?.pending !== false)
    throw new AppError(
      'UPGRADE_REQUIRED',
      'Unsupported expiry storage format',
      426,
    );
}
export async function dueEntries(storage: StateStorage) {
  const entries = await storage.list<{ key: string; at: number }>({
    prefix: 'due:',
    end: `due:${String(Date.now() + 1).padStart(16, '0')}:`,
    limit: 64,
  });
  return new Map([...entries].filter(([, value]) => value.at <= Date.now()));
}

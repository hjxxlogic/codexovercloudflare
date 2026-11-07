import { describe, expect, it, vi } from 'vitest';
import {
  expireAt,
  requireCurrentExpiry,
  nextExpiry,
} from '../apps/relay/src/expiry.ts';
import { MemoryStorage } from './helpers/do-state.ts';

describe('current expiry storage', () => {
  it('does not materialize an empty object', async () => {
    const storage = new MemoryStorage();
    const writes = vi.spyOn(storage, 'put');
    await requireCurrentExpiry(storage);
    await nextExpiry(storage);
    expect(writes).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(0);
    expect(storage.alarm).toBeNull();
  });
  it('schedules newly indexed temporary records without scanning old records', async () => {
    const storage = new MemoryStorage();
    const expires = Date.now() + 15000;
    await storage.put('ticket:new', { expires });
    await expireAt(storage, 'ticket:new', expires);
    await requireCurrentExpiry(storage);
    await nextExpiry(storage);
    expect(storage.alarm).toBe(expires);
    expect((await storage.list({ prefix: 'due:' })).size).toBe(1);
  });
  it('preserves an unchanged alarm across reconstruction and removes it once the queue drains', async () => {
    const storage = new MemoryStorage();
    const at = Date.now() + 60000;
    await expireAt(storage, 'device:pending', at);
    const set = vi.spyOn(storage, 'setAlarm');
    const remove = vi.spyOn(storage, 'deleteAlarm');
    await nextExpiry(storage);
    await nextExpiry(storage);
    expect(set).not.toHaveBeenCalled();
    expect(storage.alarm).toBe(at);
    await storage.delete([...storage.values.keys()]);
    await nextExpiry(storage);
    await nextExpiry(storage);
    expect(storage.alarm).toBeNull();
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('uses completed indexes without rewriting their metadata', async () => {
    const storage = new MemoryStorage();
    await storage.put('expiryMigration', { prefix: 3, pending: false });
    const before = structuredClone([...storage.values]);
    await requireCurrentExpiry(storage);
    await nextExpiry(storage);
    expect([...storage.values]).toEqual(before);
    expect(storage.alarm).toBeNull();
  });
  it.each([true, undefined])(
    'rejects incomplete expiry indexes without conversion (pending=%s)',
    async (pending) => {
      const storage = new MemoryStorage();
      storage.values.set('expiryMigration', { prefix: 1, pending });
      storage.values.set('ticket:original', { expires: Date.now() + 15000 });
      const before = structuredClone([...storage.values]);
      await expect(requireCurrentExpiry(storage)).rejects.toMatchObject({
        code: 'UPGRADE_REQUIRED',
      });
      expect([...storage.values]).toEqual(before);
      expect(storage.alarm).toBeNull();
    },
  );
});

import { describe, expect, it, vi } from 'vitest';
import { migrateExpiry } from '../apps/relay/src/expiry.ts';
import { MemoryStorage } from './helpers/do-state.ts';

describe('expiry migration read budget', () => {
  it('checks durable completion once per storage instance and rechecks after reconstruction', async () => {
    const storage = new MemoryStorage();
    storage.values.set('expiryMigration', { prefix: 1, pending: false });
    const reads = vi.spyOn(storage, 'get');
    for (let i = 0; i < 10; i++)
      await migrateExpiry(storage as unknown as DurableObjectStorage, [
        'ticket:',
      ]);
    expect(reads).toHaveBeenCalledTimes(1);
    const restored = new MemoryStorage();
    restored.values = structuredClone(storage.values);
    const restoredReads = vi.spyOn(restored, 'get');
    await migrateExpiry(restored as unknown as DurableObjectStorage, [
      'ticket:',
    ]);
    expect(restoredReads).toHaveBeenCalledOnce();
    expect(restored.alarm).toBeNull();
  });

  it('continues bounded pages until every finite record is indexed', async () => {
    const storage = new MemoryStorage();
    const at = Date.now() + 60000;
    for (let i = 0; i < 65; i++)
      storage.values.set('ticket:' + String(i).padStart(3, '0'), {
        expires: at,
      });
    const s = storage as unknown as DurableObjectStorage;
    await migrateExpiry(s, ['ticket:']);
    expect((await storage.list({ prefix: 'due:' })).size).toBe(64);
    await migrateExpiry(s, ['ticket:']);
    expect((await storage.list({ prefix: 'due:' })).size).toBe(65);
    expect(await storage.get('expiryMigration')).toMatchObject({
      prefix: 1,
      pending: false,
    });
    const reads = vi.spyOn(storage, 'get');
    await migrateExpiry(s, ['ticket:']);
    expect(reads).not.toHaveBeenCalled();
  });
});

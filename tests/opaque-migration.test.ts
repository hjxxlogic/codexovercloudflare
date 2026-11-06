import { describe, expect, it } from 'vitest';
import { migrateHost } from '../apps/relay/src/migration.ts';
import { MemoryStorage } from './helpers/do-state.ts';
const migrate = (storage: MemoryStorage) =>
  migrateHost(storage as unknown as DurableObjectStorage);
describe('one-way opaque Host migration', () => {
  it('resumes after a committed page and preserves wake and every legacy record', async () => {
    class Interrupted extends MemoryStorage {
      interrupt = true;
      override async transaction<T>(
        callback: (storage: MemoryStorage) => Promise<T>,
      ) {
        const value = await super.transaction(callback);
        if (this.interrupt) {
          this.interrupt = false;
          throw new Error('restart');
        }
        return value;
      }
    }
    const storage = new Interrupted();
    storage.values.set('wakeUntil', 12345);
    for (let n = 0; n < 180; n++)
      storage.values.set('lease:' + n, { epoch: n });
    await expect(migrate(storage)).rejects.toThrow('restart');
    expect(storage.values.has('channelVersion')).toBe(false);
    await migrate(storage);
    await migrate(storage);
    expect(storage.values.get('wakeUntil')).toBe(12345);
    expect(storage.values.get('channelVersion')).toBe(1);
    for (let n = 0; n < 180; n++) {
      expect(storage.values.has('lease:' + n)).toBe(false);
      expect(storage.values.get('~opaque-v1:backup:lease:' + n)).toEqual({
        epoch: n,
      });
    }
  });
  it('blocks unresolved permission side effects without completing migration', async () => {
    const storage = new MemoryStorage();
    storage.values.set('permission-operation:one', { state: 'pending' });
    await expect(migrate(storage)).rejects.toMatchObject({
      code: 'MIGRATION_PENDING',
    });
    expect(storage.values.has('channelVersion')).toBe(false);
    expect(storage.values.get('permission-operation:one')).toEqual({
      state: 'pending',
    });
  });
});

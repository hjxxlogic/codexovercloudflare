import { describe, expect, it } from 'vitest';
import {
  migrateHost,
  retireLegacyLeases,
} from '../apps/relay/src/migration.ts';
import { MemoryStorage } from './helpers/do-state.ts';
const migrate = (storage: MemoryStorage) =>
  migrateHost(storage as unknown as DurableObjectStorage);
it('reconciles only exact host-scoped reviewed leases and preserves their original state', async () => {
  const storage = new MemoryStorage();
  const key = 'lease:host~session';
  const original = { active: true, epoch: 7, pending: { epoch: 8 } };
  storage.values.set(key, original);
  const retire = (entries: unknown) =>
    retireLegacyLeases(
      storage as unknown as DurableObjectStorage,
      'host',
      entries,
    );
  await expect(retire([[key, { active: true }]])).rejects.toMatchObject({
    code: 'CONFLICT',
  });
  await expect(
    retire([['lease:other~session', original]]),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(
    retire([['permission-operation:one', original]]),
  ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  expect(storage.values.get(key)).toEqual(original);
  await retire([[key, original]]);
  expect(storage.values.get('~opaque-v1:reconciled:' + key)).toEqual(original);
  expect(storage.values.get(key)).toEqual({ active: false, epoch: 7 });
  await migrate(storage);
  expect(storage.values.get('channelVersion')).toBe(1);
  expect(storage.values.get('~opaque-v1:reconciled:' + key)).toEqual(original);
  await expect(retire([[key, original]])).rejects.toMatchObject({
    code: 'CONFLICT',
  });
});
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

it('rejects active legacy controllers and unknown future versions', async () => {
  const storage = new MemoryStorage();
  storage.values.set('lease:one', { active: true });
  await expect(migrate(storage)).rejects.toMatchObject({
    code: 'MIGRATION_PENDING',
  });
  expect(storage.values.get('lease:one')).toEqual({ active: true });
  storage.values.set('lease:one', { active: false, pending: { epoch: 7 } });
  await expect(migrate(storage)).rejects.toMatchObject({
    code: 'MIGRATION_PENDING',
  });
  expect(storage.values.get('lease:one')).toEqual({
    active: false,
    pending: { epoch: 7 },
  });
  storage.values.set('channelVersion', 2);
  await expect(migrate(storage)).rejects.toMatchObject({
    code: 'MIGRATION_FAILED',
  });
  expect(storage.values.get('channelVersion')).toBe(2);
});

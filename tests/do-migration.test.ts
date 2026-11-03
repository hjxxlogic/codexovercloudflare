import { afterEach, expect, it, vi } from 'vitest';
import { restoreRegistry } from '../apps/relay/src/do-migration.ts';
import { D1State } from '../apps/relay/src/state.ts';
import { MemoryStorage } from './helpers/do-state.ts';
import { SqliteD1 } from './helpers/d1-state.ts';
const databases: SqliteD1[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.sqlite.close();
});
function source() {
  const db = new SqliteD1();
  databases.push(db);
  return db;
}
it('resumes a failed page without exposing old grants, and never imports stale D1 again', async () => {
  const db = source(),
    local = new MemoryStorage();
  const archive = new D1State(db.binding(), 'registry');
  await archive.put({
    '@migrated': { version: 1 },
    ...Object.fromEntries(
      Array.from({ length: 140 }, (_, i) => [
        'auth:' + String(i).padStart(3, '0'),
        { generation: 2 },
      ]),
    ),
  });
  await local.put({ '@d1Migrated': true, 'auth:revoked': { generation: 1 } });
  const put = vi.spyOn(local, 'put');
  let calls = 0;
  put.mockImplementation(async (key, value) => {
    if (++calls === 2) throw new Error('storage interruption');
    return MemoryStorage.prototype.put.call(local, key, value);
  });
  await expect(restoreRegistry(local, db.binding())).rejects.toThrow(
    'storage interruption',
  );
  expect(await local.get('@doState')).toBeUndefined();
  expect(await local.get('auth:revoked')).toBeUndefined();
  put.mockRestore();
  await restoreRegistry(local, db.binding());
  expect((await local.list({ prefix: 'auth:' })).size).toBe(140);
  await local.delete('auth:001');
  vi.spyOn(db, 'prepare').mockImplementation(() => {
    throw new Error('D1 offline');
  });
  await restoreRegistry(local, db.binding());
  expect(await local.get('auth:001')).toBeUndefined();
});
it('fails closed when the migrated authorization source is unavailable', async () => {
  const local = new MemoryStorage();
  await local.put('@d1Migrated', true);
  await expect(restoreRegistry(local)).rejects.toThrow('original D1 binding');
  await expect(restoreRegistry(local, source().binding())).rejects.toThrow(
    'Original D1 state',
  );
  expect(await local.get('@doState')).toBeUndefined();
});
it('keeps legacy native authorizations for a deployment that never used D1', async () => {
  const local = new MemoryStorage();
  await local.put('auth:existing', { generation: 4 });
  await restoreRegistry(local);
  expect(await local.get('auth:existing')).toEqual({ generation: 4 });
});

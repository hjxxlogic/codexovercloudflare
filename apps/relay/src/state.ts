import { AppError } from '../../../packages/protocol/src/index.ts';

export type ListOptions = {
  prefix?: string;
  startAfter?: string;
  end?: string;
  limit?: number;
};
export interface StateTransaction {
  get<T = any>(key: string): Promise<T | undefined>;
  put(key: string | Record<string, unknown>, value?: unknown): Promise<unknown>;
  delete(key: string | string[]): Promise<unknown>;
  list<T = any>(options?: ListOptions): Promise<Map<string, T>>;
}
export interface StateStorage extends StateTransaction {
  transaction<T>(callback: (tx: StateTransaction) => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): Promise<unknown>;
  deleteAlarm(): Promise<unknown>;
}

// Reads use the primary. Never enable replica reads for authorization or fencing.
export class D1State implements StateStorage {
  constructor(
    readonly db: D1Database,
    readonly scope: string,
    private alarms?: Pick<
      StateStorage,
      'getAlarm' | 'setAlarm' | 'deleteAlarm'
    >,
    private committed?: (keys: string[]) => void,
  ) {}
  async get<T = any>(key: string): Promise<T | undefined> {
    const row = await this.db
      .prepare('SELECT value FROM relay_state WHERE scope = ? AND key = ?')
      .bind(this.scope, key)
      .first<{ value: string }>();
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  async list<T = any>(options: ListOptions = {}): Promise<Map<string, T>> {
    const conditions = ['scope = ?'];
    const bindings: (string | number)[] = [this.scope];
    if (options.prefix !== undefined) {
      conditions.push('key >= ? AND key < ?');
      bindings.push(options.prefix, options.prefix + '\uffff');
    }
    if (options.startAfter !== undefined) {
      conditions.push('key > ?');
      bindings.push(options.startAfter);
    }
    if (options.end !== undefined) {
      conditions.push('key < ?');
      bindings.push(options.end);
    }
    const result = await this.db
      .prepare(
        `SELECT key, value FROM relay_state WHERE ${conditions.join(' AND ')} ORDER BY key COLLATE BINARY LIMIT ?`,
      )
      .bind(...bindings, options.limit ?? 1000)
      .all<{ key: string; value: string }>();
    return new Map(
      result.results.map((row) => [row.key, JSON.parse(row.value) as T]),
    );
  }
  private async revision() {
    return (
      (
        await this.db
          .prepare('SELECT revision FROM relay_scopes WHERE scope = ?')
          .bind(this.scope)
          .first<{ revision: number }>()
      )?.revision ?? 0
    );
  }
  async transaction<T>(
    callback: (tx: StateTransaction) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const revision = await this.revision();
      const changes = new Map<string, string | null>();
      const tx: StateTransaction = {
        get: async <V = any>(key: string) =>
          changes.has(key)
            ? changes.get(key) === null
              ? undefined
              : (JSON.parse(changes.get(key)!) as V)
            : this.get<V>(key),
        put: async (key, value) => {
          for (const [name, entry] of typeof key === 'string'
            ? [[key, value]]
            : Object.entries(key)) {
            const encoded = JSON.stringify(entry);
            if (encoded === undefined)
              throw new Error('State values must be JSON serializable');
            changes.set(name as string, encoded);
            // Commit finite records and their expiry index together. An exit
            // between a write and alarm scheduling must not strand D1 rows.
            if (/^(auth|device|limit|operation|ticket):/.test(name as string)) {
              const record = entry as {
                expires?: number;
                until?: number;
              } | null;
              const at = record?.expires ?? record?.until;
              if (Number.isSafeInteger(at) && at! < Number.MAX_SAFE_INTEGER)
                changes.set(
                  `due:${String(at).padStart(16, '0')}:${name}`,
                  JSON.stringify({ key: name, at }),
                );
            }
          }
        },
        delete: async (key) => {
          for (const name of typeof key === 'string' ? [key] : key)
            changes.set(name, null);
        },
        list: async <V = any>(options: ListOptions = {}) => {
          // Fetch enough committed rows so buffered deletions cannot shorten a page.
          const committed = await this.list<V>({
            ...options,
            limit: (options.limit ?? 1000) + changes.size,
          });
          for (const [key, value] of changes) {
            if (
              (options.prefix !== undefined &&
                !key.startsWith(options.prefix)) ||
              (options.startAfter !== undefined && key <= options.startAfter) ||
              (options.end !== undefined && key >= options.end)
            )
              continue;
            if (value === null) committed.delete(key);
            else committed.set(key, JSON.parse(value) as V);
          }
          return new Map(
            [...committed]
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .slice(0, options.limit ?? 1000),
          );
        },
      };
      let result: T;
      try {
        result = await callback(tx);
      } catch (error) {
        if ((await this.revision()) !== revision) continue;
        throw error;
      }
      if (!changes.size) {
        if ((await this.revision()) === revision) return result;
        continue;
      }
      const token = crypto.randomUUID();
      // D1 batch is atomic. Every mutation is guarded by the successful CAS,
      // so a conflict writes neither partial state nor a new fencing epoch.
      const statements = [
        this.db
          .prepare(
            'INSERT INTO relay_scopes(scope, revision, token) SELECT ?, 1, ? WHERE ? = 0 ON CONFLICT(scope) DO UPDATE SET revision = revision + 1, token = excluded.token WHERE revision = ?',
          )
          .bind(this.scope, token, revision, revision),
      ];
      if (revision !== 0)
        statements[0] = this.db
          .prepare(
            'UPDATE relay_scopes SET revision = revision + 1, token = ? WHERE scope = ? AND revision = ?',
          )
          .bind(token, this.scope, revision);
      for (const [key, value] of changes) {
        statements.push(
          value === null
            ? this.db
                .prepare(
                  'DELETE FROM relay_state WHERE scope = ? AND key = ? AND EXISTS (SELECT 1 FROM relay_scopes WHERE scope = ? AND token = ?)',
                )
                .bind(this.scope, key, this.scope, token)
            : this.db
                .prepare(
                  'INSERT INTO relay_state(scope, key, value) SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM relay_scopes WHERE scope = ? AND token = ?) ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value',
                )
                .bind(this.scope, key, value, this.scope, token),
        );
      }
      const committed = await this.db.batch(statements);
      if (committed[0].meta.changes === 1) {
        this.committed?.([...changes.keys()]);
        return result;
      }
    }
    throw new AppError(
      'BACKPRESSURE',
      'Concurrent state updates; retry with the original request identity',
      429,
    );
  }
  put(key: string | Record<string, unknown>, value?: unknown) {
    return this.transaction((tx) => tx.put(key, value));
  }
  delete(key: string | string[]) {
    return this.transaction((tx) => tx.delete(key));
  }
  async getAlarm() {
    return this.alarms ? this.alarms.getAlarm() : null;
  }
  async setAlarm(at: number) {
    if (this.alarms) await this.alarms.setAlarm(at);
  }
  async deleteAlarm() {
    if (this.alarms) await this.alarms.deleteAlarm();
  }
}

export function d1Enabled(env: {
  STATE_BACKEND?: string;
  STATE_DB?: D1Database;
}): env is { STATE_BACKEND: 'd1'; STATE_DB: D1Database } {
  if (env.STATE_BACKEND !== 'd1') return false;
  if (!env.STATE_DB)
    throw new AppError('NOT_CONFIGURED', 'D1 state binding is required', 503);
  return true;
}

// Called behind the object's concurrency gate before any new-format work. A
// failed page leaves the legacy copy intact; the marker commits only at the end.
export async function migrateState(legacy: StateStorage, target: D1State) {
  if (await target.get('@migrated')) return;
  let after = await target.get<string>('@migrationCursor');
  for (;;) {
    const page = await legacy.list({ startAfter: after, limit: 64 });
    if (!page.size) break;
    after = [...page.keys()].at(-1);
    await target.put({
      ...Object.fromEntries(page),
      '@migrationCursor': after,
    });
    if (page.size < 64) break;
  }
  await target.transaction(async (tx) => {
    await tx.put('@migrated', { version: 1, at: Date.now() });
    await tx.delete('@migrationCursor');
  });
}

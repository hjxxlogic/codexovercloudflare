import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

// Execute the actual migration and SQL against SQLite; only the D1 transport
// shape is simulated. This catches invalid SQL, rollback and CAS mistakes.
export class SqliteD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  failBatch?: (sql: string[]) => boolean;
  beforeBatch?: () => Promise<void>;
  constructor() {
    this.sqlite.exec(
      readFileSync(
        new URL('../../migrations/d1/0001_relay_state.sql', import.meta.url),
        'utf8',
      ),
    );
  }
  prepare(sql: string) {
    return new Statement(this, sql);
  }
  async batch(statements: Statement[]) {
    await this.beforeBatch?.();
    if (this.failBatch?.(statements.map((s) => s.sql)))
      throw new Error('Injected D1 write failure');
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {
      const results = statements.map((s) => s.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
  binding() {
    return this as unknown as D1Database;
  }
}
class Statement {
  private values: (string | number | null)[] = [];
  constructor(
    private db: SqliteD1,
    readonly sql: string,
  ) {}
  bind(...values: (string | number | null)[]) {
    const bound = new Statement(this.db, this.sql);
    bound.values = values;
    return bound;
  }
  async first() {
    return this.db.sqlite.prepare(this.sql).get(...this.values) ?? null;
  }
  async all() {
    return {
      results: this.db.sqlite.prepare(this.sql).all(...this.values),
      success: true,
      meta: {},
    };
  }
  execute() {
    const result = this.db.sqlite.prepare(this.sql).run(...this.values);
    return {
      success: true,
      results: [],
      meta: { changes: Number(result.changes) },
    };
  }
}

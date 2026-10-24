import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  AppError,
  type Event,
  type Session,
} from '../../../packages/protocol/src/index.ts';

export class Store {
  db: DatabaseSync;
  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, 'agent.db'));
    this.db
      .exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, value TEXT NOT NULL, time INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS events_session ON events(session,seq);
      CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, value TEXT, time INTEGER NOT NULL);`);
    for (const s of this.sessions())
      if (s.state === 'ready')
        this.save({ ...s, state: 'failed', running: false });
  }
  save(s: Session) {
    this.db
      .prepare('INSERT OR REPLACE INTO sessions VALUES(?,?)')
      .run(s.id, JSON.stringify(s));
  }
  sessions(): Session[] {
    return this.db
      .prepare('SELECT value FROM sessions')
      .all()
      .map((r) => JSON.parse(r.value as string));
  }
  get(id: string): Session {
    const row = this.db
      .prepare('SELECT value FROM sessions WHERE id=?')
      .get(id);
    if (!row) throw new AppError('SESSION_NOT_FOUND', 'Unknown session', 404);
    return JSON.parse(row.value as string);
  }
  event(session: string, type: string, data: unknown): Event {
    const time = Date.now(),
      value = JSON.stringify({ type, data, time });
    const result = this.db
      .prepare('INSERT INTO events(session,value,time) VALUES(?,?,?)')
      .run(session, value, time);
    return { seq: Number(result.lastInsertRowid), type, data, time };
  }
  replay(id: string, after: number) {
    const rows = this.db
      .prepare(
        'SELECT seq,value FROM events WHERE session=? AND seq>? ORDER BY seq LIMIT 1000',
      )
      .all(id, after);
    const first = this.db
      .prepare('SELECT MIN(seq) AS seq FROM events WHERE session=?')
      .get(id)?.seq as number | null;
    // seq is global, so a jump alone is not evidence of a gap. Track actual pruning.
    const pruned = this.db
      .prepare('SELECT value FROM requests WHERE key=?')
      .get('pruned:' + id);
    return {
      gap: !!pruned && after < (first || Infinity),
      events: rows.map((r) => ({
        ...JSON.parse(r.value as string),
        seq: Number(r.seq),
      })) as Event[],
      more: rows.length === 1000,
    };
  }
  begin(key: string, fingerprint: string) {
    const row = this.db
      .prepare('SELECT fingerprint,value FROM requests WHERE key=?')
      .get(key);
    if (row) {
      if (row.fingerprint !== fingerprint)
        throw new AppError(
          'IDEMPOTENCY_CONFLICT',
          'Request ID was used for different content',
          409,
        );
      if (row.value === null)
        throw new AppError(
          'RESULT_UNKNOWN',
          'Previous request may have executed; inspect session state',
          409,
        );
      return { cached: true, value: JSON.parse(row.value as string) };
    }
    this.db
      .prepare('INSERT INTO requests VALUES(?,?,NULL,?)')
      .run(key, fingerprint, Date.now());
    return { cached: false, value: undefined };
  }
  finish(key: string, value: unknown) {
    this.db
      .prepare('UPDATE requests SET value=? WHERE key=?')
      .run(JSON.stringify(value), key);
  }
  cleanup() {
    const cutoff = Date.now() - 7 * 86400000;
    this.db
      .prepare('DELETE FROM requests WHERE time<? AND key NOT LIKE ?')
      .run(cutoff, 'pruned:%');
    for (const s of this.sessions().filter((s) => s.state !== 'ready')) {
      if (
        s.createdAt < cutoff ||
        Number(
          this.db.prepare('SELECT SUM(length(value)) AS size FROM events').get()
            ?.size || 0,
        ) >
          1024 ** 3
      ) {
        this.db.prepare('DELETE FROM events WHERE session=?').run(s.id);
        this.db
          .prepare('INSERT OR REPLACE INTO requests VALUES(?,?,?,?)')
          .run('pruned:' + s.id, 'pruned', 'true', Date.now());
      }
    }
    if (
      Number(
        this.db.prepare('SELECT SUM(length(value)) AS size FROM events').get()
          ?.size || 0,
      ) >
      1024 ** 3
    )
      throw new AppError(
        'STORAGE_FULL',
        'Active event log exceeded storage quota',
      );
  }
  close() {
    this.db.close();
  }
}

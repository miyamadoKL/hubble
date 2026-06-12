import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { SqlDatabase, SqlParam } from './sqlDatabase';

/**
 * SqlDatabase backed by better-sqlite3. better-sqlite3 is synchronous; we wrap
 * each call so the result is a resolved Promise, matching the async interface
 * the repositories program against. WAL / foreign_keys PRAGMAs match the
 * historical behaviour of `openDatabase`.
 */
class SqliteDatabase implements SqlDatabase {
  readonly dialect = 'sqlite' as const;

  constructor(private readonly db: Database.Database) {}

  query<T = Record<string, unknown>>(sql: string, params: readonly SqlParam[] = []): Promise<T[]> {
    const rows = this.db.prepare(sql).all(...(params as SqlParam[])) as T[];
    return Promise.resolve(rows);
  }

  run(sql: string, params: readonly SqlParam[] = []): Promise<void> {
    this.db.prepare(sql).run(...(params as SqlParam[]));
    return Promise.resolve();
  }

  exec(sql: string): Promise<void> {
    this.db.exec(sql);
    return Promise.resolve();
  }

  async transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T> {
    // better-sqlite3's own `.transaction()` cannot span an `await`, so we drive
    // BEGIN/COMMIT/ROLLBACK explicitly. Our callbacks only issue synchronous
    // better-sqlite3 calls, so no real concurrency crosses the boundary.
    this.db.exec('BEGIN');
    try {
      const result = await fn(this);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  close(): Promise<void> {
    this.db.close();
    return Promise.resolve();
  }
}

/**
 * Open (or create) a SQLite database at `dbPath` and return the async adapter.
 * Pass ':memory:' for tests. Caller is responsible for running migrations.
 */
export function openSqlite(dbPath: string): SqlDatabase {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return new SqliteDatabase(db);
}

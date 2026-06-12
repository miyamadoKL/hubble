import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations, runMigrations } from './migrate';
import type { SqlDatabase } from './sqlDatabase';
import { openSqlite } from './sqliteAdapter';
import { openPostgres } from './postgresAdapter';

export type { SqlDatabase, SqlDialect, SqlParam } from './sqlDatabase';

const here = dirname(fileURLToPath(import.meta.url));
/** migrations/ lives at the package root (../../migrations from src/db). */
export const MIGRATIONS_DIR = resolve(here, '../../migrations');

/** Backend selection: a PostgreSQL connection string or a SQLite file path. */
export type DatabaseSource = { kind: 'postgres'; url: string } | { kind: 'sqlite'; path: string };

/**
 * Open the database for `source`, run pending migrations, and return the async
 * `SqlDatabase`. SQLite is the historical default (file or ':memory:');
 * PostgreSQL is selected when `DATABASE_URL` is set (see config.ts).
 */
export async function openDatabase(source: DatabaseSource): Promise<SqlDatabase> {
  const db = source.kind === 'postgres' ? openPostgres(source.url) : openSqlite(source.path);
  try {
    await runMigrations(db, loadMigrations(MIGRATIONS_DIR));
  } catch (err) {
    await db.close();
    throw err;
  }
  return db;
}

/** Convenience for tests: an in-memory SQLite database with migrations applied. */
export function openMemoryDatabase(): Promise<SqlDatabase> {
  return openDatabase({ kind: 'sqlite', path: ':memory:' });
}

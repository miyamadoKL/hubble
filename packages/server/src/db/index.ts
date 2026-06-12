import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations, runMigrations } from './migrate';

const here = dirname(fileURLToPath(import.meta.url));
/** migrations/ lives at the package root (../../migrations from src/db). */
export const MIGRATIONS_DIR = resolve(here, '../../migrations');

/**
 * Open (or create) the SQLite database at `dbPath` and run pending migrations.
 * Pass ':memory:' for tests.
 */
export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, loadMigrations(MIGRATIONS_DIR));
  return db;
}

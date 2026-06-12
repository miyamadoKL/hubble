import type Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A single migration: a numbered SQL file. */
export interface Migration {
  /** Zero-padded sequence number parsed from the filename (e.g. 1, 2, ...). */
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_FILE_RE = /^(\d+)[._-].*\.sql$/;

/** Load migrations from a directory, sorted by their numeric prefix. */
export function loadMigrations(dir: string): Migration[] {
  const files = readdirSync(dir).filter((f) => MIGRATION_FILE_RE.test(f));
  const migrations = files.map((file) => {
    const match = MIGRATION_FILE_RE.exec(file);
    // Guarded by the filter above, but keep TS strict happy.
    const version = match ? Number.parseInt(match[1]!, 10) : NaN;
    return {
      version,
      name: file,
      sql: readFileSync(join(dir, file), 'utf8'),
    } satisfies Migration;
  });
  migrations.sort((a, b) => a.version - b.version);

  // Detect duplicate version numbers early.
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} (${m.name})`);
    }
    seen.add(m.version);
  }
  return migrations;
}

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/** Versions already applied, ascending. */
export function appliedVersions(db: Database.Database): number[] {
  ensureMigrationsTable(db);
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as {
    version: number;
  }[];
  return rows.map((r) => r.version);
}

/**
 * Apply all pending migrations in order. Each migration runs inside a
 * transaction together with its `schema_migrations` bookkeeping row.
 * Returns the list of versions newly applied.
 */
export function runMigrations(db: Database.Database, migrations: Migration[]): number[] {
  ensureMigrationsTable(db);
  const already = new Set(appliedVersions(db));
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  const applied: number[] = [];
  for (const migration of migrations) {
    if (already.has(migration.version)) continue;
    const apply = db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, new Date().toISOString());
    });
    apply();
    applied.push(migration.version);
  }
  return applied;
}

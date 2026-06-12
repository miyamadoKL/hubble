import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlDatabase } from './sqlDatabase';

/** Structural shape of the pg adapter's advisory-lock helper (no import cycle). */
interface AdvisoryLockable {
  withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T>;
}

function hasAdvisoryLock(db: SqlDatabase): db is SqlDatabase & AdvisoryLockable {
  return typeof (db as Partial<AdvisoryLockable>).withAdvisoryLock === 'function';
}

/** A single migration: a numbered SQL file. */
export interface Migration {
  /** Zero-padded sequence number parsed from the filename (e.g. 1, 2, ...). */
  version: number;
  name: string;
  sql: string;
}

const MIGRATION_FILE_RE = /^(\d+)[._-].*\.sql$/;

/**
 * A stable 64-bit-ish key for pg_advisory_lock so concurrent server startups
 * serialize their migrations. Arbitrary constant unique to Hubble migrations.
 */
const MIGRATION_ADVISORY_LOCK_KEY = 4_021_980_513;

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

async function ensureMigrationsTable(db: SqlDatabase): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/** Versions already applied, ascending. */
export async function appliedVersions(db: SqlDatabase): Promise<number[]> {
  await ensureMigrationsTable(db);
  const rows = await db.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version ASC',
  );
  // pg returns INTEGER as a JS number; coerce defensively for both dialects.
  return rows.map((r) => Number(r.version));
}

/**
 * Apply all pending migrations in order. Each migration runs inside a
 * transaction together with its `schema_migrations` bookkeeping row. On
 * PostgreSQL the whole pass is serialized with a session advisory lock so
 * concurrent startups don't race. Returns the list of versions newly applied.
 */
export async function runMigrations(db: SqlDatabase, migrations: Migration[]): Promise<number[]> {
  if (db.dialect === 'postgres' && hasAdvisoryLock(db)) {
    return db.withAdvisoryLock(MIGRATION_ADVISORY_LOCK_KEY, () => applyMigrations(db, migrations));
  }
  return applyMigrations(db, migrations);
}

async function applyMigrations(db: SqlDatabase, migrations: Migration[]): Promise<number[]> {
  await ensureMigrationsTable(db);
  const already = new Set(await appliedVersions(db));

  const applied: number[] = [];
  for (const migration of migrations) {
    if (already.has(migration.version)) continue;
    await db.transaction(async (tx) => {
      // Each migration file may contain multiple statements; run as one script.
      await tx.exec(migration.sql);
      await tx.run('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)', [
        migration.version,
        migration.name,
        new Date().toISOString(),
      ]);
    });
    applied.push(migration.version);
  }
  return applied;
}

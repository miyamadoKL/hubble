import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrations, runMigrations, appliedVersions } from './migrate';
import { openMemoryDatabase, openDatabase, MIGRATIONS_DIR } from './index';
import { openSqlite } from './sqliteAdapter';
import type { SqlDatabase } from './sqlDatabase';
import { pgEnabled } from '../test/dbBackends';

async function tableNames(db: SqlDatabase): Promise<string[]> {
  const rows =
    db.dialect === 'postgres'
      ? await db.query<{ name: string }>(
          "SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY name",
        )
      : await db.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        );
  return rows.map((r) => r.name);
}

function withTempMigrations(files: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'hf-mig-'));
  return (async () => {
    try {
      for (const [name, sql] of Object.entries(files)) {
        writeFileSync(join(dir, name), sql);
      }
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  })();
}

/** A bare in-memory SQLite handle (no migrations applied yet). */
function freshSqlite(): SqlDatabase {
  return openSqlite(':memory:');
}

describe('loadMigrations', () => {
  it('orders by numeric prefix and ignores non-matching files', () =>
    withTempMigrations(
      {
        '0002_b.sql': 'CREATE TABLE b (id INTEGER);',
        '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
        'README.md': 'not a migration',
        'notes.sql.bak': 'ignored',
      },
      (dir) => {
        const migrations = loadMigrations(dir);
        expect(migrations.map((m) => m.version)).toEqual([1, 2]);
        expect(migrations.map((m) => m.name)).toEqual(['0001_a.sql', '0002_b.sql']);
        return Promise.resolve();
      },
    ));

  it('throws on duplicate version numbers', () =>
    withTempMigrations({ '0001_a.sql': 'SELECT 1;', '0001_b.sql': 'SELECT 1;' }, (dir) => {
      expect(() => loadMigrations(dir)).toThrow(/Duplicate migration version 1/);
      return Promise.resolve();
    }));
});

describe('runMigrations', () => {
  it('applies pending migrations once and is idempotent', () =>
    withTempMigrations(
      {
        '0001_a.sql': 'CREATE TABLE a (id INTEGER PRIMARY KEY);',
        '0002_b.sql': 'CREATE TABLE b (id INTEGER PRIMARY KEY);',
      },
      async (dir) => {
        const db = freshSqlite();
        const migrations = loadMigrations(dir);

        const first = await runMigrations(db, migrations);
        expect(first).toEqual([1, 2]);
        expect(await appliedVersions(db)).toEqual([1, 2]);
        expect(await tableNames(db)).toContain('a');
        expect(await tableNames(db)).toContain('b');

        // Re-running applies nothing.
        const second = await runMigrations(db, migrations);
        expect(second).toEqual([]);
        expect(await appliedVersions(db)).toEqual([1, 2]);
        await db.close();
      },
    ));

  it('applies only newly added migrations on a second pass', async () => {
    const db = freshSqlite();
    await withTempMigrations({ '0001_a.sql': 'CREATE TABLE a (id INTEGER);' }, async (dir) => {
      await runMigrations(db, loadMigrations(dir));
    });
    expect(await appliedVersions(db)).toEqual([1]);

    await withTempMigrations(
      {
        '0001_a.sql': 'CREATE TABLE a (id INTEGER);',
        '0002_c.sql': 'CREATE TABLE c (id INTEGER);',
      },
      async (dir) => {
        const applied = await runMigrations(db, loadMigrations(dir));
        expect(applied).toEqual([2]);
      },
    );
    expect(await appliedVersions(db)).toEqual([1, 2]);
    expect(await tableNames(db)).toContain('c');
    await db.close();
  });

  it('rolls back a failing migration (no partial bookkeeping)', () =>
    withTempMigrations(
      {
        '0001_ok.sql': 'CREATE TABLE ok (id INTEGER);',
        '0002_bad.sql': 'CREATE TABLE bad (id INTEGER); THIS IS NOT SQL;',
      },
      async (dir) => {
        const db = freshSqlite();
        const migrations = loadMigrations(dir);
        await expect(runMigrations(db, migrations)).rejects.toThrow();
        // Migration 1 committed; migration 2 fully rolled back.
        expect(await appliedVersions(db)).toEqual([1]);
        expect(await tableNames(db)).toContain('ok');
        expect(await tableNames(db)).not.toContain('bad');
        await db.close();
      },
    ));
});

describe('openDatabase with the real initial migration', () => {
  it('creates notebooks / saved_queries / query_history', async () => {
    const db = await openMemoryDatabase();
    const names = await tableNames(db);
    expect(names).toContain('notebooks');
    expect(names).toContain('saved_queries');
    expect(names).toContain('query_history');
    expect(names).toContain('schema_migrations');
    expect(await appliedVersions(db)).toContain(1);
    await db.close();
  });

  it('loads the real migrations directory', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]!.version).toBe(1);
  });

  it('removes Parquet compatibility schema and keeps the JSONL retention index', async () => {
    const db = await openMemoryDatabase();
    const columns = await db.query<{ name: string; notnull: number }>(
      'PRAGMA table_info(query_history)',
    );
    expect(columns.map(({ name }) => name)).toContain('result_columns_json');
    expect(columns.map(({ name }) => name)).not.toEqual(
      expect.arrayContaining([
        'result_format',
        'parquet_object_key',
        'parquet_expires_at',
        'parquet_encoding_version',
      ]),
    );
    const indexes = await db.query<{ name: string; sql: string }>(
      `SELECT name, sql FROM sqlite_master
       WHERE type='index' AND name IN
         ('idx_query_history_retention', 'idx_query_history_parquet_expiry_cursor',
          'idx_query_history_parquet_object_key')`,
    );
    expect(indexes.map((index) => index.name).sort()).toEqual(['idx_query_history_retention']);
    expect(indexes.find((index) => index.name === 'idx_query_history_retention')?.sql).toMatch(
      /result_object_key IS NULL/,
    );
    expect(indexes.find((index) => index.name === 'idx_query_history_retention')?.sql).not.toMatch(
      /parquet_object_key/,
    );
    expect(await tableNames(db)).not.toContain('result_parquet_conversion_jobs');
    await db.close();
  });
});

// PostgreSQL-only: idempotent migrations + advisory-lock serialization. Gated on
// TEST_DATABASE_URL so a developer's default `pnpm test` (no pg) stays green.
const describePg = pgEnabled ? describe : describe.skip;
describePg('migrations on postgres (TEST_DATABASE_URL)', () => {
  const url = process.env.TEST_DATABASE_URL!;
  // Derive the expected set from the real migrations dir so adding a new
  // migration file doesn't break these assertions.
  const allVersions = loadMigrations(MIGRATIONS_DIR).map((m) => m.version);

  it('applies the real migrations and is idempotent', async () => {
    // First open applies everything; second open should be a no-op (advisory
    // lock acquired/released cleanly, no duplicate-apply).
    const db1 = await openDatabase({ kind: 'postgres', url });
    expect(await appliedVersions(db1)).toEqual(allVersions);
    await db1.close();

    const db2 = await openDatabase({ kind: 'postgres', url });
    expect(await appliedVersions(db2)).toEqual(allVersions);
    expect(await tableNames(db2)).toEqual(
      expect.arrayContaining([
        'notebooks',
        'saved_queries',
        'query_history',
        'schedules',
        'schedule_runs',
        'schema_migrations',
      ]),
    );
    await db2.close();
  });

  it('serializes concurrent startup migrations under the advisory lock', async () => {
    // Two concurrent opens race for the advisory lock; both must converge to the
    // same applied set with no error and no duplicate rows.
    const [a, b] = await Promise.all([
      openDatabase({ kind: 'postgres', url }),
      openDatabase({ kind: 'postgres', url }),
    ]);
    expect(await appliedVersions(a)).toEqual(allVersions);
    expect(await appliedVersions(b)).toEqual(allVersions);
    await a.close();
    await b.close();
  });
});

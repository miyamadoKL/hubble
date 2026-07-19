import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrations, runMigrations, appliedVersions } from './migrate';
import { MIGRATIONS_DIR } from './index';
import { openPostgresWorkerDatabase } from '../test/dbBackends';
import type { SqlDatabase } from './sqlDatabase';

async function tableNames(db: SqlDatabase): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    'SELECT tablename AS name FROM pg_tables WHERE schemaname = current_schema() ORDER BY name',
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

describe('openDatabase with the real initial migration', () => {
  it('loads the real migrations directory', () => {
    const migrations = loadMigrations(MIGRATIONS_DIR);
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2]);
    expect(migrations[0]!.name).toBe('0001_baseline.sql');
    expect(migrations[1]!.name).toBe('0002_schedule_saved_query.sql');
  });
});

describe('migrations on postgres (TEST_DATABASE_URL)', () => {
  const url = process.env.TEST_DATABASE_URL!;
  // 実際のマイグレーション一覧から期待値を作り、新しいファイル追加で検証が壊れないようにする。
  const allVersions = loadMigrations(MIGRATIONS_DIR).map((m) => m.version);

  it('applies the real migrations and is idempotent', async () => {
    // 初回openで全てを適用し、2回目はadvisory lockを取得しても重複適用しない。
    const db1 = await openPostgresWorkerDatabase(url);
    expect(await appliedVersions(db1)).toEqual(allVersions);
    await db1.close();

    const db2 = await openPostgresWorkerDatabase(url);
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
    const columns = await db2.query<{ column_name: string; column_default: string | null }>(
      `SELECT column_name, column_default
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name IN ('notebooks', 'saved_queries', 'query_history')
          AND column_name = 'owner'`,
    );
    expect(columns).toHaveLength(3);
    expect(columns.every((column) => column.column_default === null)).toBe(true);
    const legacyColumns = await db2.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND (column_name IN ('result_format', 'parquet_object_key',
                               'parquet_expires_at', 'parquet_encoding_version')
               OR table_name = 'result_parquet_conversion_jobs')`,
    );
    expect(legacyColumns).toHaveLength(0);
    const jsonlColumns = await db2.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name='query_history'
          AND column_name IN ('result_object_key', 'result_expires_at', 'result_columns_json')`,
    );
    expect(jsonlColumns).toHaveLength(3);
    await db2.close();
  });

  it('serializes concurrent startup migrations under the advisory lock', async () => {
    // 2つのopenがadvisory lockを競合しても、同じ適用済み集合へ収束する。
    const [a, b] = await Promise.all([
      openPostgresWorkerDatabase(url),
      openPostgresWorkerDatabase(url),
    ]);
    expect(await appliedVersions(a)).toEqual(allVersions);
    expect(await appliedVersions(b)).toEqual(allVersions);
    await a.close();
    await b.close();
  });

  it('applies pending migrations incrementally and skips applied versions', async () => {
    const db = await openPostgresWorkerDatabase(url);
    const migrations = [
      {
        version: 910001,
        name: '910001_incremental_a.sql',
        sql: 'CREATE TABLE p2_3a_incremental_a (id INTEGER PRIMARY KEY);',
      },
      {
        version: 910002,
        name: '910002_incremental_b.sql',
        sql: 'CREATE TABLE p2_3a_incremental_b (id INTEGER PRIMARY KEY);',
      },
    ];
    try {
      await cleanupCustomMigrations(db);
      expect(await runMigrations(db, migrations)).toEqual([910001, 910002]);
      expect(await runMigrations(db, migrations)).toEqual([]);
      expect(await appliedVersions(db)).toEqual([...allVersions, 910001, 910002]);
      expect(await tableNames(db)).toEqual(
        expect.arrayContaining(['p2_3a_incremental_a', 'p2_3a_incremental_b']),
      );
    } finally {
      await cleanupCustomMigrations(db);
      await db.close();
    }
  });

  it('rolls back a failed migration and keeps its version unapplied', async () => {
    const db = await openPostgresWorkerDatabase(url);
    const migrations = [
      {
        version: 910003,
        name: '910003_rollback_ok.sql',
        sql: 'CREATE TABLE p2_3a_rollback_ok (id INTEGER PRIMARY KEY);',
      },
      {
        version: 910004,
        name: '910004_rollback_failed.sql',
        sql: `
          CREATE TABLE p2_3a_rollback_failed (id INTEGER PRIMARY KEY);
          INSERT INTO p2_3a_missing (id) VALUES (1);
        `,
      },
    ];
    try {
      await cleanupCustomMigrations(db);
      await expect(runMigrations(db, migrations)).rejects.toThrow(/p2_3a_missing/);
      expect(await appliedVersions(db)).toEqual([...allVersions, 910003]);
      const tables = await tableNames(db);
      expect(tables).toContain('p2_3a_rollback_ok');
      expect(tables).not.toContain('p2_3a_rollback_failed');
    } finally {
      await cleanupCustomMigrations(db);
      await db.close();
    }
  });
});

async function cleanupCustomMigrations(db: SqlDatabase): Promise<void> {
  await db.run('DELETE FROM schema_migrations WHERE version BETWEEN 910001 AND 910004');
  await db.exec(`
    DROP TABLE IF EXISTS p2_3a_incremental_a;
    DROP TABLE IF EXISTS p2_3a_incremental_b;
    DROP TABLE IF EXISTS p2_3a_rollback_ok;
    DROP TABLE IF EXISTS p2_3a_rollback_failed;
  `);
}

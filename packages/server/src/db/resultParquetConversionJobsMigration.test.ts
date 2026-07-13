import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations } from './migrate';
import type { SqlDatabase } from './sqlDatabase';
import { MIGRATIONS_DIR } from './index';
import { openSqlite } from './sqliteAdapter';
import { dbBackends } from '../test/dbBackends';

for (const backend of dbBackends) {
  describe(`retired result schema migration on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) await db.close();
    });

    it('retains the legacy tombstone schema without its live indexes', async () => {
      db = await backend.open();
      if (backend.name === 'sqlite') {
        const historyColumns = await db.query<{ name: string }>('PRAGMA table_info(query_history)');
        expect(historyColumns.map((column) => column.name)).toContain('parquet_encoding_version');
        const jobColumns = await db.query<{ name: string }>(
          'PRAGMA table_info(result_parquet_conversion_jobs)',
        );
        expect(jobColumns.map((column) => column.name)).toEqual([
          'history_id',
          'source_object_key',
          'target_object_key',
          'encoding_version',
          'status',
          'attempts',
          'next_attempt_at',
          'last_error_code',
          'last_error',
          'created_at',
          'updated_at',
        ]);
        const indexes = await db.query<{ name: string }>(
          `SELECT name FROM sqlite_master
           WHERE type='index' AND tbl_name='result_parquet_conversion_jobs'`,
        );
        expect(indexes.map((index) => index.name)).toContain(
          'idx_result_parquet_conversion_jobs_due',
        );
        const historyIndexes = await db.query<{ name: string; sql: string | null }>(
          `SELECT name, sql FROM sqlite_master
           WHERE type='index' AND name IN
             ('idx_query_history_retention', 'idx_query_history_parquet_expiry_cursor',
              'idx_query_history_parquet_object_key')`,
        );
        expect(historyIndexes.map((index) => index.name)).toEqual(['idx_query_history_retention']);
        expect(historyIndexes[0]?.sql).toMatch(/result_object_key IS NULL/);
        expect(historyIndexes[0]?.sql).not.toMatch(/parquet_object_key/);
        return;
      }

      const historyColumns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='query_history' AND column_name='parquet_encoding_version'`,
      );
      expect(historyColumns).toHaveLength(1);
      const jobColumns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name='result_parquet_conversion_jobs'
         ORDER BY ordinal_position`,
      );
      expect(jobColumns.map((column) => column.column_name)).toEqual([
        'history_id',
        'source_object_key',
        'target_object_key',
        'encoding_version',
        'status',
        'attempts',
        'next_attempt_at',
        'last_error_code',
        'last_error',
        'created_at',
        'updated_at',
      ]);
      const indexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE tablename='result_parquet_conversion_jobs'`,
      );
      expect(indexes.map((index) => index.indexname)).toContain(
        'idx_result_parquet_conversion_jobs_due',
      );
      const historyIndexes = await db.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes
         WHERE tablename='query_history'
           AND indexname IN
             ('idx_query_history_retention', 'idx_query_history_parquet_expiry_cursor',
              'idx_query_history_parquet_object_key')`,
      );
      expect(historyIndexes.map((index) => index.indexname)).toEqual([
        'idx_query_history_retention',
      ]);
      expect(historyIndexes[0]?.indexdef).toMatch(/result_object_key IS NULL/);
      expect(historyIndexes[0]?.indexdef).not.toMatch(/parquet_object_key/);
    });

    it('preserves 0022 data when 0023 retires the live indexes', async () => {
      const migrations = loadMigrations(MIGRATIONS_DIR);
      const retirement = migrations.find((migration) => migration.version === 23);
      expect(retirement).toBeDefined();
      if (retirement === undefined) return;

      if (backend.name === 'sqlite') {
        db = openSqlite(':memory:');
        await runMigrations(
          db,
          migrations.filter((migration) => migration.version <= 22),
        );
      } else {
        // PostgreSQL は共有テスト DB の全 migration 適用後に 0022 の index 状態を再現する。
        db = await backend.open();
      }

      await db.run('DROP INDEX IF EXISTS idx_query_history_retention');
      await db.run('DROP INDEX IF EXISTS idx_query_history_parquet_expiry_cursor');
      await db.run('DROP INDEX IF EXISTS idx_query_history_parquet_object_key');
      await db.run(
        `CREATE INDEX idx_query_history_retention
           ON query_history (submitted_at, id)
           WHERE result_object_key IS NULL AND parquet_object_key IS NULL`,
      );
      await db.run(
        `CREATE INDEX idx_query_history_parquet_expiry_cursor
           ON query_history (parquet_expires_at, id)
           WHERE parquet_object_key IS NOT NULL AND parquet_expires_at IS NOT NULL`,
      );
      await db.run(
        `CREATE INDEX idx_query_history_parquet_object_key
           ON query_history (parquet_object_key)
           WHERE parquet_object_key IS NOT NULL`,
      );

      const historyId = `migration-preserve-${backend.name}`;
      const jobKey = `legacy/${historyId}.parquet`;
      await db.run(
        `INSERT INTO query_history
           (id, statement, state, owner, datasource_id, submitted_at,
            result_object_key, result_expires_at, result_columns_json, result_format,
            parquet_object_key, parquet_expires_at, parquet_encoding_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyId,
          'SELECT 1',
          'finished',
          'alice',
          'trino-default',
          '2026-01-01T00:00:00.000Z',
          `legacy/${historyId}.jsonl.zst`,
          '2026-02-01T00:00:00.000Z',
          '[]',
          'jsonl.zst',
          jobKey,
          '2026-02-01T00:00:00.000Z',
          '1',
        ],
      );
      await db.run(
        `INSERT INTO result_parquet_conversion_jobs
           (history_id, source_object_key, target_object_key, encoding_version,
            status, attempts, next_attempt_at, last_error_code, last_error,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          historyId,
          `legacy/${historyId}.jsonl.zst`,
          jobKey,
          '1',
          'pending',
          2,
          '2026-01-02T00:00:00.000Z',
          'duckdb_error',
          'legacy conversion pending',
          '2026-01-01T00:00:00.000Z',
          '2026-01-01T00:00:00.000Z',
        ],
      );

      const beforeHistory = await db.query(
        'SELECT parquet_object_key, parquet_expires_at, parquet_encoding_version FROM query_history WHERE id=?',
        [historyId],
      );
      const beforeJob = await db.query(
        'SELECT * FROM result_parquet_conversion_jobs WHERE history_id=?',
        [historyId],
      );

      await db.transaction(async (tx) => {
        await tx.exec(retirement.sql);
      });

      expect(
        await db.query(
          'SELECT parquet_object_key, parquet_expires_at, parquet_encoding_version FROM query_history WHERE id=?',
          [historyId],
        ),
      ).toEqual(beforeHistory);
      expect(
        await db.query('SELECT * FROM result_parquet_conversion_jobs WHERE history_id=?', [
          historyId,
        ]),
      ).toEqual(beforeJob);

      if (backend.name === 'sqlite') {
        const indexes = await db.query<{ name: string; sql: string | null }>(
          `SELECT name, sql FROM sqlite_master
           WHERE type='index' AND name IN
             ('idx_query_history_retention', 'idx_query_history_parquet_expiry_cursor',
              'idx_query_history_parquet_object_key')`,
        );
        expect(indexes.map((index) => index.name)).toEqual(['idx_query_history_retention']);
        expect(indexes[0]?.sql).toMatch(/result_object_key IS NULL/);
        expect(indexes[0]?.sql).not.toMatch(/parquet_object_key/);
      } else {
        const indexes = await db.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef FROM pg_indexes
           WHERE tablename='query_history'
             AND indexname IN
               ('idx_query_history_retention', 'idx_query_history_parquet_expiry_cursor',
                'idx_query_history_parquet_object_key')`,
        );
        expect(indexes.map((index) => index.indexname)).toEqual(['idx_query_history_retention']);
        expect(indexes[0]?.indexdef).toMatch(/result_object_key IS NULL/);
        expect(indexes[0]?.indexdef).not.toMatch(/parquet_object_key/);
      }
    });
  });
}

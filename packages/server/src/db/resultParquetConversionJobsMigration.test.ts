import { afterEach, describe, expect, it } from 'vitest';
import { loadMigrations, runMigrations } from './migrate';
import type { SqlDatabase } from './sqlDatabase';
import { MIGRATIONS_DIR } from './index';
import { openSqlite } from './sqliteAdapter';
import { dbBackends } from '../test/dbBackends';

async function assertRetainedJsonlSchema(db: SqlDatabase): Promise<void> {
  const row = await db.query<{
    result_object_key: string;
    result_expires_at: string;
    result_columns_json: string;
  }>(
    `SELECT result_object_key, result_expires_at, result_columns_json
       FROM query_history WHERE id=?`,
    ['jsonl-retained'],
  );
  expect(row).toEqual([
    {
      result_object_key: 'results/jsonl-retained.jsonl.zst',
      result_expires_at: '2026-02-01T00:00:00.000Z',
      result_columns_json: '[]',
    },
  ]);

  const table =
    db.dialect === 'sqlite'
      ? await db.query<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='result_parquet_conversion_jobs'",
        )
      : await db.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='result_parquet_conversion_jobs'",
        );
  expect(table).toHaveLength(0);

  const indexes =
    db.dialect === 'sqlite'
      ? await db.query<{ name: string; sql: string | null }>(
          `SELECT name, sql FROM sqlite_master
           WHERE type='index' AND name='idx_query_history_retention'`,
        )
      : await db.query<{ indexname: string; indexdef: string }>(
          `SELECT indexname, indexdef FROM pg_indexes
           WHERE tablename='query_history' AND indexname='idx_query_history_retention'`,
        );
  expect(indexes).toHaveLength(1);
  expect(JSON.stringify(indexes[0])).toMatch(/result_object_key IS NULL/);
}

for (const backend of dbBackends) {
  describe(`removed result compatibility schema on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) await db.close();
    });

    it('removes Parquet compatibility data while retaining JSONL history', async () => {
      const migrations = loadMigrations(MIGRATIONS_DIR);
      const removal = migrations.find((migration) => migration.version === 24);
      expect(removal).toBeDefined();
      if (removal === undefined) return;

      if (backend.name === 'sqlite') {
        db = openSqlite(':memory:');
        await runMigrations(
          db,
          migrations.filter((migration) => migration.version <= 23),
        );
        await db.run(
          `INSERT INTO query_history
             (id, statement, state, owner, datasource_id, submitted_at,
              result_object_key, result_expires_at, result_columns_json, result_format,
              parquet_object_key, parquet_expires_at, parquet_encoding_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            'jsonl-retained',
            'SELECT 1',
            'finished',
            'alice',
            'trino-default',
            '2026-01-01T00:00:00.000Z',
            'results/jsonl-retained.jsonl.zst',
            '2026-02-01T00:00:00.000Z',
            '[]',
            'jsonl.zst',
            'legacy/jsonl-retained.parquet',
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
            'jsonl-retained',
            'results/jsonl-retained.jsonl.zst',
            'legacy/jsonl-retained.parquet',
            '1',
            'pending',
            0,
            '2026-01-01T00:00:00.000Z',
            null,
            null,
            '2026-01-01T00:00:00.000Z',
            '2026-01-01T00:00:00.000Z',
          ],
        );
        await runMigrations(db, [removal]);
        await assertRetainedJsonlSchema(db);
      } else {
        db = await backend.open();
        const rollbackMarker = 'rollback migration transition test';
        try {
          await db.transaction(async (tx) => {
            await tx.exec(`
              ALTER TABLE query_history ADD COLUMN result_format TEXT;
              ALTER TABLE query_history ADD COLUMN parquet_object_key TEXT;
              ALTER TABLE query_history ADD COLUMN parquet_expires_at TEXT;
              ALTER TABLE query_history ADD COLUMN parquet_encoding_version TEXT;
              CREATE TABLE result_parquet_conversion_jobs (
                history_id TEXT PRIMARY KEY,
                source_object_key TEXT NOT NULL,
                target_object_key TEXT NOT NULL UNIQUE,
                encoding_version TEXT NOT NULL,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL,
                next_attempt_at TEXT NOT NULL,
                last_error_code TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
              );
              CREATE INDEX idx_result_parquet_conversion_jobs_due
                ON result_parquet_conversion_jobs (status, next_attempt_at, history_id);
            `);
            await tx.run(
              `INSERT INTO query_history
                 (id, statement, state, owner, datasource_id, submitted_at,
                  result_object_key, result_expires_at, result_columns_json,
                  result_format, parquet_object_key, parquet_expires_at,
                  parquet_encoding_version)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                'jsonl-retained',
                'SELECT 1',
                'finished',
                'alice',
                'trino-default',
                '2026-01-01T00:00:00.000Z',
                'results/jsonl-retained.jsonl.zst',
                '2026-02-01T00:00:00.000Z',
                '[]',
                'jsonl.zst',
                'legacy/jsonl-retained.parquet',
                '2026-02-01T00:00:00.000Z',
                '1',
              ],
            );
            await tx.run(
              `INSERT INTO result_parquet_conversion_jobs
                 (history_id, source_object_key, target_object_key, encoding_version,
                  status, attempts, next_attempt_at, last_error_code, last_error,
                  created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                'jsonl-retained',
                'results/jsonl-retained.jsonl.zst',
                'legacy/jsonl-retained.parquet',
                '1',
                'pending',
                0,
                '2026-01-01T00:00:00.000Z',
                null,
                null,
                '2026-01-01T00:00:00.000Z',
                '2026-01-01T00:00:00.000Z',
              ],
            );

            await tx.exec(removal.sql);
            await assertRetainedJsonlSchema(tx);

            const remainingColumns = await tx.query<{ column_name: string }>(
              `SELECT column_name
                 FROM information_schema.columns
                WHERE table_schema='public'
                  AND table_name='query_history'
                  AND column_name IN ('result_format', 'parquet_object_key',
                                      'parquet_expires_at', 'parquet_encoding_version')`,
            );
            expect(remainingColumns).toHaveLength(0);
            throw new Error(rollbackMarker);
          });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== rollbackMarker) throw error;
        }

        const restoredColumns = await db.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema='public'
              AND table_name='query_history'
              AND column_name = 'result_columns_json'`,
        );
        expect(restoredColumns).toHaveLength(1);
        const restoredTable = await db.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='result_parquet_conversion_jobs'",
        );
        expect(restoredTable).toHaveLength(0);
        const restoredLegacyColumns = await db.query<{ column_name: string }>(
          `SELECT column_name
             FROM information_schema.columns
            WHERE table_schema='public'
              AND table_name='query_history'
              AND column_name = ANY(ARRAY['result_format', 'parquet_object_key',
                                          'parquet_expires_at', 'parquet_encoding_version'])`,
        );
        expect(restoredLegacyColumns).toHaveLength(0);
      }
    });
  });
}

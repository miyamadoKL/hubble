import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from './sqlDatabase';
import { dbBackends } from '../test/dbBackends';

for (const backend of dbBackends) {
  describe(`result parquet conversion migration on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) await db.close();
    });

    it('creates the durable job contract and parquet encoding column', async () => {
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
    });
  });
}

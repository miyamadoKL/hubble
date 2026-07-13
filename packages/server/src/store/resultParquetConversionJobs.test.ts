import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { dbBackends } from '../test/dbBackends';
import {
  ResultParquetConversionJobRepository,
  type ResultParquetConversionJobInput,
} from './resultParquetConversionJobs';

for (const backend of dbBackends) {
  describe(`ResultParquetConversionJobRepository on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) await db.close();
    });

    async function open(): Promise<ResultParquetConversionJobRepository> {
      db = await backend.open();
      return new ResultParquetConversionJobRepository(db);
    }

    function input(
      historyId: string,
      targetObjectKey = `${historyId}.parquet`,
    ): ResultParquetConversionJobInput {
      return {
        historyId,
        sourceObjectKey: `${historyId}.jsonl.zst`,
        targetObjectKey,
        encodingVersion: '1',
      };
    }

    it('enqueue is idempotent and preserves the first target key', async () => {
      const repo = await open();
      const first = await repo.enqueue(input('h1', 'target-a'), '2026-07-13T00:00:00.000Z');
      const duplicate = await repo.enqueue(input('h1', 'target-b'), '2026-07-13T00:01:00.000Z');

      expect(duplicate).toMatchObject({
        historyId: 'h1',
        targetObjectKey: 'target-a',
        status: 'pending',
        attempts: 0,
      });
      expect(first.targetObjectKey).toBe('target-a');
      await expect(
        repo.enqueue(input('h2', 'target-a'), '2026-07-13T00:02:00.000Z'),
      ).rejects.toThrow();
    });

    it('claims pending jobs by due time and history id without a running state', async () => {
      const repo = await open();
      await repo.enqueue(input('h-late'), '2026-07-13T00:10:00.000Z');
      await repo.enqueue(input('h-early-b'), '2026-07-13T00:01:00.000Z');
      await repo.enqueue(input('h-early-a'), '2026-07-13T00:01:00.000Z');

      const jobs = await repo.claimDue('2026-07-13T00:05:00.000Z', 10);
      expect(jobs.map((job) => job.historyId)).toEqual(['h-early-a', 'h-early-b']);
      expect(jobs.every((job) => job.status === 'pending')).toBe(true);
    });

    it('records retry, terminal deletion, delete, and dead pruning', async () => {
      const repo = await open();
      await repo.enqueue(input('h-retry'), '2026-07-13T00:00:00.000Z');
      await repo.markRetry(
        'h-retry',
        1,
        '2026-07-13T00:05:00.000Z',
        'duckdb_error',
        'temporary',
        '2026-07-13T00:01:00.000Z',
      );
      expect(await repo.get('h-retry')).toMatchObject({
        status: 'pending',
        attempts: 1,
        lastErrorCode: 'duckdb_error',
      });

      await repo.enqueue(input('h-dead'), '2026-07-13T00:00:00.000Z');
      await repo.markDead(
        'h-dead',
        5,
        'unsupported_type',
        'unsupported',
        '2026-07-13T00:02:00.000Z',
      );
      await repo.enqueue(input('h-obsolete'), '2026-07-13T00:00:00.000Z');
      await repo.markObsolete(
        'h-obsolete',
        'source_expired',
        'expired',
        '2026-07-13T00:03:00.000Z',
      );
      await repo.enqueue(input('h-complete'), '2026-07-13T00:00:00.000Z');
      await repo.markComplete('h-complete', '2026-07-13T00:04:00.000Z');

      expect((await repo.get('h-dead'))?.status).toBe('dead');
      expect(await repo.get('h-obsolete')).toBeUndefined();
      expect(await repo.get('h-complete')).toBeUndefined();
      expect(await repo.pruneDead('2026-07-13T00:10:00.000Z', 10)).toBe(1);
      await repo.delete('h-obsolete');
      expect(await repo.get('h-obsolete')).toBeUndefined();
    });
  });
}

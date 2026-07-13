/** query_history と workflow の両方を含む結果 object 参照判定を検証する。 */
import { afterEach, describe, expect, it } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { dbBackends } from '../test/dbBackends';
import { HistoryRepository } from './history';
import { ResultObjectDeletionRepository } from './resultObjectDeletions';

for (const backend of dbBackends) {
  describe(`ResultObjectDeletionRepository on ${backend.name}`, () => {
    let db: SqlDatabase;

    afterEach(async () => {
      if (db) await db.close();
    });

    it('query の JSONL/Parquet と workflow の参照を保護する', async () => {
      db = await backend.open();
      const history = new HistoryRepository(db);
      const deletions = new ResultObjectDeletionRepository(db);
      const expiresAt = '2026-02-01T00:00:00.000Z';

      expect(await deletions.isReferenced('unreferenced')).toBe(false);

      await history.insert({
        id: 'h_ref',
        statement: 'SELECT 1',
        state: 'finished',
        owner: 'alice',
        datasourceId: 'trino-default',
        submittedAt: '2026-01-01T00:00:00.000Z',
      });
      await history.setResultObject(
        'h_ref',
        'jsonl-ref',
        expiresAt,
        { state: 'finished', rowCount: 1, elapsedMs: 1 },
        [],
        'jsonl.gz',
      );
      await history.setParquetObject('h_ref', 'jsonl-ref', 'parquet-ref', '1');

      expect(await deletions.isReferenced('jsonl-ref')).toBe(true);
      expect(await deletions.isReferenced('parquet-ref')).toBe(true);

      await db.run(
        `INSERT INTO workflow_step_runs
           (id, run_id, workflow_id, step_id, stage_index, name, datasource_id, status,
            attempt, result_object_key, result_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          'step_ref',
          'run_ref',
          'workflow_ref',
          'step',
          0,
          'step',
          'trino-default',
          'success',
          1,
          'workflow-ref',
          expiresAt,
        ],
      );
      expect(await deletions.isReferenced('workflow-ref')).toBe(true);
    });
  });
}

import { describe, expect, it } from 'vitest';
import { openPostgres } from '../db/postgresAdapter';
import { openPostgresWorkerDatabase, postgresWorkerSchema, postgresWorkerUrl } from './dbBackends';
import type { SqlDatabase } from '../db/sqlDatabase';

describe('PostgreSQL worker backend', () => {
  it('VITEST_POOL_IDの数字だけをschema名に使い、無効値は決定的にfallbackする', () => {
    expect(postgresWorkerSchema('12')).toBe('hubble_test_worker_12');
    expect(postgresWorkerSchema('worker-12')).toBe('hubble_test_worker_0');
    expect(postgresWorkerSchema('')).toBe('hubble_test_worker_0');
    expect(postgresWorkerSchema('１２')).toBe('hubble_test_worker_0');
  });

  it('既存のoptionsを保持してworker schemaをsearch_pathへ追加する', () => {
    const url = postgresWorkerUrl(
      'postgres://hubble:secret@127.0.0.1/hubble' +
        '?options=-c%20search_path%3Dpublic%20-c%20statement_timeout%3D4',
      '12',
    );

    expect(new URL(url).searchParams.get('options')).toBe(
      '-c search_path=public -c statement_timeout=4 -c search_path=hubble_test_worker_12',
    );
  });
});

describe('PostgreSQL worker schema integration', () => {
  const url = process.env.TEST_DATABASE_URL!;
  const schemaA = postgresWorkerSchema('9001');
  const schemaB = postgresWorkerSchema('9002');

  it('workerごとにschemaとTRUNCATEの対象を分離する', async () => {
    let workerA: SqlDatabase | undefined;
    let workerB: SqlDatabase | undefined;
    try {
      [workerA, workerB] = await Promise.all([
        openPostgresWorkerDatabase(url, '9001'),
        openPostgresWorkerDatabase(url, '9002'),
      ]);

      const schemas = await Promise.all([
        workerA.query<{ schema: string }>('SELECT current_schema() AS schema'),
        workerB.query<{ schema: string }>('SELECT current_schema() AS schema'),
      ]);
      expect(schemas[0]![0]!.schema).toBe(schemaA);
      expect(schemas[1]![0]!.schema).toBe(schemaB);

      const insertNotebook = (db: SqlDatabase, id: string) =>
        db.run(
          `INSERT INTO notebooks
             (id, name, description, data, created_at, updated_at, owner)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            'worker test',
            '',
            '{}',
            new Date().toISOString(),
            new Date().toISOString(),
            'owner',
          ],
        );
      await Promise.all([insertNotebook(workerA, 'worker-a'), insertNotebook(workerB, 'worker-b')]);

      await workerA.run('TRUNCATE "notebooks"');
      const counts = await Promise.all([
        workerA.query<{ count: number }>('SELECT count(*)::integer AS count FROM notebooks'),
        workerB.query<{ count: number }>('SELECT count(*)::integer AS count FROM notebooks'),
      ]);
      expect(counts[0]![0]!.count).toBe(0);
      expect(counts[1]![0]!.count).toBe(1);
    } finally {
      await Promise.all([workerA?.close(), workerB?.close()]);
      const cleanup = openPostgres(url);
      try {
        await cleanup.run(`DROP SCHEMA IF EXISTS "${schemaA}" CASCADE`);
        await cleanup.run(`DROP SCHEMA IF EXISTS "${schemaB}" CASCADE`);
      } finally {
        await cleanup.close();
      }
    }
  });
});

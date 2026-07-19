import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { updateSavedQueryRequestSchema } from '@hubble/contracts';
import { loadMigrations, runMigrations, appliedVersions } from './migrate';
import { MIGRATIONS_DIR } from './index';
import { openPostgresWorkerDatabase } from '../test/dbBackends';
import { openPostgres } from './postgresAdapter';
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
    expect(migrations.map((migration) => migration.version)).toEqual([1, 2, 3]);
    expect(migrations[0]!.name).toBe('0001_baseline.sql');
    expect(migrations[1]!.name).toBe('0002_schedule_saved_query.sql');
    expect(migrations[2]!.name).toBe('0003_schedule_saved_query_only.sql');
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

describe('0003_schedule_saved_query_only.sql (直書き schedule の saved query 化)', () => {
  const url = process.env.TEST_DATABASE_URL!;
  const migrations = loadMigrations(MIGRATIONS_DIR);
  const migrationsUpToV2 = migrations.filter((m) => m.version <= 2);
  const migrationV3 = migrations.find((m) => m.version === 3)!;

  /**
   * 0001/0002 適用直後（0003 未適用）の状態を再現するため、専用の schema を使って
   * マイグレーションを version 2 で止め、legacy な直書き schedule 行を直接 INSERT
   * してから 0003 を適用する。呼び出し元は返された `db`（スコープ済み接続）で
   * 変換結果を検証し、`cleanup()` を必ず呼ぶこと。
   */
  async function migrateLegacySchedule(row: {
    id: string;
    owner: string;
    name: string;
    statement: string;
    catalog?: string | null;
    schema?: string | null;
    datasourceId?: string;
    principalSnapshot?: string | null;
  }): Promise<{ db: SqlDatabase; schemaName: string; cleanup: () => Promise<void> }> {
    const schemaName = `hubble_test_mig0003_${randomUUID().replace(/-/g, '')}`;
    const bootstrap = openPostgres(url);
    try {
      await bootstrap.run(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
    } finally {
      await bootstrap.close();
    }
    const scopedUrl = new URL(url);
    scopedUrl.searchParams.set('options', `-c search_path=${schemaName}`);
    const db = openPostgres(scopedUrl.toString());
    await runMigrations(db, migrationsUpToV2);

    // 0002 時点の schedules は statement を直書きできる。移行前の legacy 行を
    // 直接 INSERT で再現する（この時点では saved_query_id は未使用）。
    await db.run(
      `INSERT INTO schedules
         (id, owner, name, statement, catalog, schema, cron, enabled,
          retry_max_attempts, retry_backoff_seconds, retry_backoff_multiplier,
          created_at, updated_at, datasource_id, principal_snapshot, notifications)
       VALUES
         ($1, $2, $3, $4, $5, $6, '0 0 * * *', 1,
          3, 60, 2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', $7, $8, NULL)`,
      [
        row.id,
        row.owner,
        row.name,
        row.statement,
        row.catalog ?? null,
        row.schema ?? null,
        row.datasourceId ?? 'trino-default',
        row.principalSnapshot ?? null,
      ],
    );

    await runMigrations(db, [migrationV3]);

    const cleanup = async () => {
      await db.close();
      const teardown = openPostgres(url);
      try {
        await teardown.run(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      } finally {
        await teardown.close();
      }
    };
    return { db, schemaName, cleanup };
  }

  it('converts a legacy statement-based schedule into a saved query and links it', async () => {
    const { db, cleanup } = await migrateLegacySchedule({
      id: 'sch_legacy',
      owner: 'alice',
      name: 'nightly rollup',
      statement: 'SELECT 1',
      catalog: 'tpch',
      schema: 'tiny',
    });
    try {
      // schedules 側: statement 系の列は落ち、saved_query_id が NOT NULL で埋まっている。
      const scheduleRows = await db.query<{ saved_query_id: string }>(
        'SELECT saved_query_id FROM schedules WHERE id = $1',
        ['sch_legacy'],
      );
      expect(scheduleRows).toHaveLength(1);
      const savedQueryId = scheduleRows[0]!.saved_query_id;
      expect(savedQueryId).toMatch(/^sq_/);

      const scheduleColumns = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'schedules'
             AND column_name IN ('statement', 'catalog', 'schema', 'datasource_id')`,
      );
      expect(scheduleColumns).toHaveLength(0);

      // 変換先の saved query が、statement/catalog/schema/datasource_id/owner を
      // そのまま引き継いでいる。name は schedule 名をそのまま引き継ぎ、接尾辞は
      // 付加しない（付加すると MAX_NAME_LENGTH の上限を超えうるため。下の
      // 「200 文字境界」テストを参照）。
      const savedQueryRows = await db.query<{
        name: string;
        statement: string;
        catalog: string | null;
        schema: string | null;
        datasource_id: string | null;
        owner: string;
      }>(
        'SELECT name, statement, catalog, schema, datasource_id, owner FROM saved_queries WHERE id = $1',
        [savedQueryId],
      );
      expect(savedQueryRows).toEqual([
        {
          name: 'nightly rollup',
          statement: 'SELECT 1',
          catalog: 'tpch',
          schema: 'tiny',
          datasource_id: 'trino-default',
          owner: 'alice',
        },
      ]);
    } finally {
      await cleanup();
    }
  });

  // P1 指摘: schedule 名（契約上限 MAX_NAME_LENGTH = 200 文字）に " (schedule)"
  // を接尾辞として付加すると 211 文字になり、契約層の updateSavedQueryRequestSchema
  // （name: max 200）を超えるため、移行後に saved query 名を編集保存できなくなる
  // 不具合があった。接尾辞を廃止したことで、上限ちょうどの schedule 名でも
  // 変換後にそのまま編集可能であることを確認する。
  it('carries over a 200-character schedule name without exceeding the saved query name limit', async () => {
    const maxLengthName = 'x'.repeat(200);
    const { db, cleanup } = await migrateLegacySchedule({
      id: 'sch_long_name',
      owner: 'alice',
      name: maxLengthName,
      statement: 'SELECT 1',
    });
    try {
      const rows = await db.query<{ saved_query_id: string }>(
        'SELECT saved_query_id FROM schedules WHERE id = $1',
        ['sch_long_name'],
      );
      const savedQueryId = rows[0]!.saved_query_id;
      const savedQueryRows = await db.query<{ name: string }>(
        'SELECT name FROM saved_queries WHERE id = $1',
        [savedQueryId],
      );
      expect(savedQueryRows[0]!.name).toBe(maxLengthName);
      expect(savedQueryRows[0]!.name).toHaveLength(200);

      // 変換後の名前が契約層のバリデーション（保存済みクエリの編集保存で通る
      // update リクエスト）を実際に満たすことを確認する。
      expect(
        updateSavedQueryRequestSchema.safeParse({
          name: savedQueryRows[0]!.name,
          description: '',
          statement: 'SELECT 1',
          isFavorite: false,
        }).success,
      ).toBe(true);
    } finally {
      await cleanup();
    }
  });

  // P1 指摘: 変換後の schedule が「実行可能なまま残る」ことは、saved query の
  // statement を読み戻すだけでは不十分（principal_snapshot が NULL の fixture だと
  // scheduler は常に PRINCIPAL_SNAPSHOT_REQUIRED で拒否するため、statement の内容が
  // 正しくても実行できるとは限らない）。principal_snapshot が非 NULL の legacy
  // schedule を変換し、repository 経由の解決から Scheduler.runManual による実際の
  // 実行（EXPLAIN VALIDATE → 実行）まで通ることを確認する。
  it('remains executable end-to-end after conversion (repository → scheduler run)', async () => {
    const { db, cleanup } = await migrateLegacySchedule({
      id: 'sch_exec',
      owner: 'alice',
      name: 'still runs after migration',
      statement: 'SELECT_MIGRATED_STILL_RUNS',
      principalSnapshot: JSON.stringify({ user: 'alice' }),
    });
    try {
      const [
        { ScheduleRepository, ScheduleRunRepository },
        { SavedQueryRepository },
        { DocumentShareRepository },
        { FakeTrino },
        { makeEnginesMap, DEFAULT_DATASOURCE_ID },
        { EstimateService },
        { JobAdmissionController },
        { Scheduler },
      ] = await Promise.all([
        import('../store/schedules'),
        import('../store/savedQueries'),
        import('../store/documentShares'),
        import('../test/fakeTrino'),
        import('../test/testEngine'),
        import('../query/estimateService'),
        import('../schedule/admission'),
        import('../schedule/scheduler'),
      ]);

      const schedules = new ScheduleRepository(db);
      const runs = new ScheduleRunRepository(db, 50);
      const savedQueries = new SavedQueryRepository(db, new DocumentShareRepository(db));

      // 変換後の schedule を repository 経由で解決する（マイグレーションの生 SQL では
      // なく、実際にサーバーが読む経路を通す）。
      const schedule = await schedules.getById('sch_exec');
      expect(schedule?.principalSnapshot).toEqual({ user: 'alice' });
      expect(schedule?.savedQueryId).toMatch(/^sq_/);

      const fake = new FakeTrino([
        {
          match: 'EXPLAIN (TYPE VALIDATE)',
          pages: [{ columns: [{ name: 'result', type: 'boolean' }], data: [[true]] }],
        },
        {
          match: 'SELECT_MIGRATED_STILL_RUNS',
          trinoId: 'qmigrated',
          pages: [{ columns: [{ name: 'n', type: 'bigint' }], data: [[1]] }],
        },
      ]);
      const { engines, defaultDatasourceId } = makeEnginesMap(fake);
      expect(defaultDatasourceId).toBe(DEFAULT_DATASOURCE_ID);
      const estimate = new EstimateService(engines, defaultDatasourceId, {
        mode: 'off',
        maxScanBytes: 0,
        maxScanRows: 0,
        onUnknown: 'allow',
        estimateTimeoutMs: 3000,
        cacheTtlSeconds: 0,
        bytesPerSecond: 0,
      });
      const scheduler = new Scheduler({
        schedules,
        runs,
        savedQueries,
        engines,
        defaultDatasourceId,
        estimate,
        getRbac: () => ({
          roles: new Map([
            ['unrestricted', { permissions: new Set(['query.write']), datasources: ['*'] }],
          ]),
          assignments: [],
          defaultRole: 'unrestricted',
        }),
        guardConfig: {
          mode: 'off',
          maxScanBytes: 0,
          maxScanRows: 0,
          onUnknown: 'allow',
          estimateTimeoutMs: 3000,
          cacheTtlSeconds: 0,
          bytesPerSecond: 0,
        },
        admission: new JobAdmissionController(2),
        config: {
          enabled: false,
          tickSeconds: 15,
          maxConcurrent: 2,
          runsRetention: 50,
          guardMode: 'off',
        },
        sleep: () => Promise.resolve(),
      });

      const { runId } = await scheduler.runManual(schedule!);
      await scheduler.whenIdle();

      const recorded = await runs.list(schedule!.id, 10);
      expect(recorded[0]!.id).toBe(runId);
      expect(recorded[0]!.status).toBe('success');
      expect(recorded[0]!.trinoQueryId).toMatch(/^qmigrated_/);
      expect(recorded[0]!.rowCount).toBe(1);
    } finally {
      await cleanup();
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

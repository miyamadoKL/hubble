import { openDatabase } from '../db';
import { openPostgres } from '../db/postgresAdapter';
import type { SqlDatabase } from '../db/sqlDatabase';

const TEST_PG_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';
if (!TEST_PG_URL) {
  throw new Error('TEST_DATABASE_URL is required for PostgreSQL server tests');
}

/** リポジトリテストが触れる全テーブル。ケース間にworker schema内を空にする。 */
const OWNED_TABLES = [
  'notebooks',
  'saved_queries',
  'dashboards',
  'document_shares',
  'query_history',
  'schedules',
  'schedule_runs',
  'workflows',
  'workflow_runs',
  'workflow_step_runs',
  'result_object_deletions',
  'alerts',
  'alert_deliveries',
  'audit_log',
  'github_connections',
  'document_git_links',
] as const;

const WORKER_SCHEMA_PREFIX = 'hubble_test_worker_';
const FALLBACK_WORKER_ID = '0';

function workerId(poolId: string | undefined): string {
  return poolId !== undefined && /^\d+$/.test(poolId) ? poolId : FALLBACK_WORKER_ID;
}

/** Vitest workerごとの安全なPostgreSQL schema名を返す。 */
export function postgresWorkerSchema(poolId = process.env.VITEST_POOL_ID): string {
  return `${WORKER_SCHEMA_PREFIX}${workerId(poolId)}`;
}

/** 既存optionsを保ったままworker schemaをsearch_pathへ追加する。 */
export function postgresWorkerUrl(
  connectionString: string,
  poolId = process.env.VITEST_POOL_ID,
): string {
  const url = new URL(connectionString);
  const existingOptions = url.searchParams.get('options')?.trim();
  const searchPath = `-c search_path=${postgresWorkerSchema(poolId)}`;
  url.searchParams.set(
    'options',
    [existingOptions, searchPath].filter((value): value is string => Boolean(value)).join(' '),
  );
  return url.toString();
}

/** worker schemaを作成してから、同schemaへ接続しマイグレーションを適用する。 */
export async function openPostgresWorkerDatabase(
  connectionString: string,
  poolId = process.env.VITEST_POOL_ID,
): Promise<SqlDatabase> {
  const schema = postgresWorkerSchema(poolId);
  const bootstrap = openPostgres(connectionString);
  try {
    await bootstrap.run(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
  } finally {
    await bootstrap.close();
  }
  return openDatabase({
    url: postgresWorkerUrl(connectionString, poolId),
  });
}

/** API結合テスト用のPostgreSQLを開く。接続先とworker隔離を隠蔽する。 */
export async function openTestDatabase(): Promise<SqlDatabase> {
  const db = await openPostgresWorkerDatabase(TEST_PG_URL);
  await db.run(`TRUNCATE ${OWNED_TABLES.map((table) => `"${table}"`).join(', ')}`);
  return db;
}

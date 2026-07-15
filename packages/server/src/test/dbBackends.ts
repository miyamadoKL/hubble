import { openMemoryDatabase, openDatabase } from '../db';
import { openPostgres } from '../db/postgresAdapter';
import type { SqlDatabase } from '../db/sqlDatabase';

/**
 * リポジトリ層のテスト (store/*.test.ts 等) を SQLite / PostgreSQL の両方の
 * 実装で共通に実行するための、テスト用バックエンド定義を提供するファイル。
 *
 * SQLite は常に (依存不要で) 実行される一方、PostgreSQL は環境変数
 * `TEST_DATABASE_URL` が設定されている場合のみ実行対象に加わる
 * (`RUN_TRINO_IT` を使った realTrino.it.test.ts の実 Trino 統合テストの
 * ゲーティングと同じ考え方)。これにより、pg が使えない開発者のローカル環境
 * (`pnpm test`) でも常にテストがフルグリーンになる一方、CI 等で
 * `TEST_DATABASE_URL` を設定すれば pg 実装も同じテストスイートで検証できる。
 */

/** テスト対象の永続化バックエンド。SQLite は常に、PostgreSQL は環境変数が
 * 設定されている場合だけ実行し、両方の方言で同じリポジトリ契約を検証する。 */
export interface DbBackend {
  name: 'sqlite' | 'postgres';
  /** 既存データから隔離した、マイグレーション済みのDBを開く。 */
  open(): Promise<SqlDatabase>;
}

// 日本語: テスト実行時にこの環境変数が設定されていれば、それを接続先として
// PostgreSQL バックエンドのテストも走らせる。未設定なら pg 関連テストはスキップ。
const TEST_PG_URL = process.env.TEST_DATABASE_URL;

/** リポジトリテストが触れる全テーブル。PostgreSQLではケース間に削除する。 */
// 日本語: リポジトリテストが読み書きしうる全テーブル名。pg バックエンドでは
// テストケースごとにこれらを TRUNCATE してデータを空にし、テスト間の
// 干渉を防ぐ (SQLite は毎回新規のインメモリ DB を開くため不要)。
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

// SQLite バックエンド定義。open() のたびに新規のインメモリ DB を
// 生成するため、テストケース間の分離は自然に得られる (マイグレーションも
// openMemoryDatabase 内で適用される)。
const sqliteBackend: DbBackend = {
  name: 'sqlite',
  // テストごとに新しいインメモリDBを開くため、自然に状態が分離される。
  open: () => openMemoryDatabase(),
};

const WORKER_SCHEMA_PREFIX = 'hubble_test_worker_';
const FALLBACK_WORKER_ID = '0';

function workerId(poolId: string | undefined): string {
  return poolId !== undefined && /^\d+$/.test(poolId) ? poolId : FALLBACK_WORKER_ID;
}

/** Vitest workerごとの安全なPostgreSQL schema名を返す。 */
export function postgresWorkerSchema(poolId = process.env.VITEST_POOL_ID): string {
  return `${WORKER_SCHEMA_PREFIX}${workerId(poolId)}`;
}

/** 既存の接続 options を保ったまま worker schema を search_path の末尾に指定する。 */
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
    kind: 'postgres',
    url: postgresWorkerUrl(connectionString, poolId),
  });
}

// TEST_PG_URL が設定されている場合のみ PostgreSQL バックエンド定義を生成する。
// workerごとに schema を分け、同一 worker 内だけ TRUNCATE する。
const postgresBackend: DbBackend | undefined = TEST_PG_URL
  ? {
      name: 'postgres',
      async open() {
        const db = await openPostgresWorkerDatabase(TEST_PG_URL);
        await db.run(`TRUNCATE ${OWNED_TABLES.map((table) => `"${table}"`).join(', ')}`);
        return db;
      },
    }
  : undefined;

/**
 * リポジトリテストをパラメータ化するバックエンド一覧。
 * `describe.each(dbBackends)` のようにテストスイート側で使うことを想定し、
 * SQLite は必ず含め、PostgreSQL は環境が整っている場合だけ追加する。
 */
export const dbBackends: DbBackend[] = postgresBackend
  ? [sqliteBackend, postgresBackend]
  : [sqliteBackend];

/** PostgreSQL 専用テストを実行できる環境かどうかを示すフラグ。 */
// dbBackends に頼らず PostgreSQL だけを実行するテストが、自身をスキップするか
// どうかの判定に使う。
export const pgEnabled = postgresBackend !== undefined;

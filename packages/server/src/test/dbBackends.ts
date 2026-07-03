import { openMemoryDatabase, openDatabase } from '../db';
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

/**
 * A persistence backend under test. SQLite always runs; PostgreSQL runs only
 * when `TEST_DATABASE_URL` is set (mirrors the `RUN_TRINO_IT` gating used by
 * realTrino.it.test.ts). This lets the same repository suite exercise both
 * dialects, while keeping a developer's `pnpm test` (no pg) fully green.
 */
export interface DbBackend {
  name: 'sqlite' | 'postgres';
  /** Open a fresh, migrated database, isolated from prior test data. */
  open(): Promise<SqlDatabase>;
}

// 日本語: テスト実行時にこの環境変数が設定されていれば、それを接続先として
// PostgreSQL バックエンドのテストも走らせる。未設定なら pg 関連テストはスキップ。
const TEST_PG_URL = process.env.TEST_DATABASE_URL;

/** All tables a repository test may touch; truncated between pg test cases. */
// 日本語: リポジトリテストが読み書きしうる全テーブル名。pg バックエンドでは
// テストケースごとにこれらを TRUNCATE してデータを空にし、テスト間の
// 干渉を防ぐ (SQLite は毎回新規のインメモリ DB を開くため不要)。
const OWNED_TABLES = ['notebooks', 'saved_queries', 'query_history', 'schedules', 'schedule_runs'] as const;

// 日本語: SQLite バックエンド定義。open() のたびに新規のインメモリ DB を
// 生成するため、テストケース間の分離は自然に得られる (マイグレーションも
// openMemoryDatabase 内で適用される)。
const sqliteBackend: DbBackend = {
  name: 'sqlite',
  // A fresh in-memory database per test gives natural isolation.
  open: () => openMemoryDatabase(),
};

// 日本語: TEST_PG_URL が設定されている場合のみ PostgreSQL バックエンド定義を
// 生成する (未設定なら undefined のままとなり、以降 dbBackends/pgEnabled から
// 除外される)。open() は共有 DB への接続を開いたのち、前のテストケースが
// 残したデータを TRUNCATE で除去してから返す (マイグレーション管理テーブル
// 自体はここでは触らない)。
const postgresBackend: DbBackend | undefined = TEST_PG_URL
  ? {
      name: 'postgres',
      async open() {
        const db = await openDatabase({ kind: 'postgres', url: TEST_PG_URL });
        // Isolate each test: a shared pg database persists across cases, so wipe
        // the user tables (migrations / schema_migrations stay intact).
        await db.run(`TRUNCATE ${OWNED_TABLES.join(', ')}`);
        return db;
      },
    }
  : undefined;

/**
 * The backends to parameterize a repository suite over. SQLite is always
 * present; PostgreSQL is appended only when `TEST_DATABASE_URL` is set.
 *
 * 日本語: `describe.each(dbBackends)` のようにテストスイート側で使うことを
 * 想定した配列。SQLite は必ず含まれ、pg は環境が整っている場合のみ追加される。
 */
export const dbBackends: DbBackend[] = postgresBackend
  ? [sqliteBackend, postgresBackend]
  : [sqliteBackend];

/** True when the pg-gated suites should run (TEST_DATABASE_URL is set). */
// 日本語: pg 専用のテスト (dbBackends に頼らず個別に pg のみ実行したいケース) が
// 自身をスキップするかどうかの判定に使うフラグ。
export const pgEnabled = postgresBackend !== undefined;

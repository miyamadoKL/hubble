/**
 * db パッケージの公開エントリーポイント。SQLite / PostgreSQL いずれかの
 * バックエンドを選び、マイグレーション適用まで済ませた `SqlDatabase` を返す
 * `openDatabase()` を提供する。上位のアプリケーションコードはこのモジュール
 * 経由でのみデータベースを開き、SQLite/PostgreSQL の違いを意識しない。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations, runMigrations } from './migrate';
import type { SqlDatabase } from './sqlDatabase';
import { openSqlite } from './sqliteAdapter';
import { openPostgres } from './postgresAdapter';
import type { PostgresTimeouts } from './postgresTimeouts';

// SqlDatabase まわりの型はこのモジュールからも re-export し、呼び出し側が
// 個々のファイルパスを意識しなくて済むようにする。
export type { SqlDatabase, SqlDialect, SqlParam } from './sqlDatabase';

// このファイル（src/db/index.ts）が置かれているディレクトリの絶対パス。
// ESM では __dirname が使えないため import.meta.url から算出する。
const here = dirname(fileURLToPath(import.meta.url));
/** migrations/ lives at the package root (../../migrations from src/db). */
// migrations/ ディレクトリはパッケージルート直下に置かれている
// （src/db から見て ../../migrations）。ビルド後でも実行時でも
// このファイルからの相対パスで解決できるようにしている。
export const MIGRATIONS_DIR = resolve(here, '../../migrations');

/** Backend selection: a PostgreSQL connection string or a SQLite file path. */
/**
 * PostgreSQL の接続文字列と期限設定、または SQLite のファイルパスを指定する
 * 判別可能ユニオン型。
 */
export type DatabaseSource =
  | { kind: 'postgres'; url: string; timeouts?: PostgresTimeouts }
  | { kind: 'sqlite'; path: string };

/**
 * Open the database for `source`, run pending migrations, and return the async
 * `SqlDatabase`. SQLite is the historical default (file or ':memory:');
 * PostgreSQL is selected when `DATABASE_URL` is set (see config.ts).
 *
 * `source` で指定されたデータベースを開き、未適用のマイグレーションを実行
 * したうえで `SqlDatabase` を返す。SQLite（ファイルまたは ':memory:'）が
 * 歴史的なデフォルトで、`DATABASE_URL` が設定されている場合は PostgreSQL が
 * 選ばれる（config.ts 参照）。マイグレーション適用に失敗した場合は開いた
 * 接続をきちんと閉じてからエラーを再送出する。
 */
export async function openDatabase(source: DatabaseSource): Promise<SqlDatabase> {
  // kind に応じてどちらかのアダプターを使ってコネクション（または接続プール）
  // を確立する。この時点ではまだマイグレーションは実行されていない。
  const db =
    source.kind === 'postgres'
      ? openPostgres(source.url, source.timeouts)
      : openSqlite(source.path);
  try {
    // migrations/ 配下の SQL ファイルを読み込み、未適用のものを順に適用する。
    await runMigrations(db, loadMigrations(MIGRATIONS_DIR));
  } catch (err) {
    // マイグレーション失敗時は接続を開けっぱなしにせず必ず閉じてから、
    // 元のエラーを呼び出し元へ伝播させる。
    await db.close();
    throw err;
  }
  return db;
}

/** Convenience for tests: an in-memory SQLite database with migrations applied. */
// テスト用の簡易ヘルパー。':memory:' の SQLite データベースを開き、
// マイグレーション適用まで済ませた状態で返す。テストごとに独立したDBが
// 得られるため、テスト間の状態共有を避けられる。
export function openMemoryDatabase(): Promise<SqlDatabase> {
  return openDatabase({ kind: 'sqlite', path: ':memory:' });
}

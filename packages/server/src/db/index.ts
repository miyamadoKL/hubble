/** PostgreSQL接続を開き、マイグレーション適用済みのSqlDatabaseを返す。 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrations, runMigrations } from './migrate';
import type { SqlDatabase } from './sqlDatabase';
import { openPostgres } from './postgresAdapter';
import type { PostgresTimeouts } from './postgresTimeouts';

// SqlDatabase まわりの型はこのモジュールからも re-export し、呼び出し側が
// 個々のファイルパスを意識しなくて済むようにする。
export type { SqlDatabase, SqlParam } from './sqlDatabase';

// このファイル（src/db/index.ts）が置かれているディレクトリの絶対パス。
// ESM では __dirname が使えないため import.meta.url から算出する。
const here = dirname(fileURLToPath(import.meta.url));
/** migrations/ lives at the package root (../../migrations from src/db). */
// migrations/ ディレクトリはパッケージルート直下に置かれている
// （src/db から見て ../../migrations）。ビルド後でも実行時でも
// このファイルからの相対パスで解決できるようにしている。
export const MIGRATIONS_DIR = resolve(here, '../../migrations');

/** PostgreSQLの接続文字列と期限設定。 */
export interface DatabaseSource {
  url: string;
  timeouts?: PostgresTimeouts;
}

/** PostgreSQLを開き、未適用のマイグレーションを実行して返す。 */
export async function openDatabase(source: DatabaseSource): Promise<SqlDatabase> {
  const db = openPostgres(source.url, source.timeouts);
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

/**
 * スキーママイグレーションの読み込みと適用を担うモジュール。
 *
 * migrations/ ディレクトリにある `<番号>_<名前>.sql` 形式のファイルを
 * `loadMigrations()` で読み込み、`runMigrations()` で未適用のものだけを
 * バージョン順に適用する。適用済みバージョンは `schema_migrations`
 * テーブルに記録し、各マイグレーションはそのブックキーピング行への
 * INSERT と同じトランザクション内で実行することで、SQL 適用と記録が
 * 必ず対になるようにしている。PostgreSQL ではさらにセッション単位の
 * advisory lock で複数プロセスの同時起動時のマイグレーション競合を防ぐ。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlDatabase } from './sqlDatabase';

/** PostgreSQL adapterのadvisory lock helperの構造型。循環参照を避ける。 */
// postgresAdapter.ts の `withAdvisoryLock` メソッドの構造的な型のみをここで
// 定義する。postgresAdapter.ts を直接 import すると循環参照になり得るため、
// 「このメソッドを持っているかどうか」だけをダックタイピングで判定する。
interface AdvisoryLockable {
  withAdvisoryLock<T>(key: number, fn: () => Promise<T>): Promise<T>;
}

// db が withAdvisoryLock メソッドを持つかどうかを実行時にチェックする型ガード。
// PostgreSQL のマイグレーション advisory lock を提供するか確認する。
function hasAdvisoryLock(db: SqlDatabase): db is SqlDatabase & AdvisoryLockable {
  return typeof (db as Partial<AdvisoryLockable>).withAdvisoryLock === 'function';
}

// 1つのマイグレーションファイルを表す。ファイル名の先頭の数字が version、
// ファイル名そのものが name、ファイルの中身（複数の SQL 文を含み得る）が sql。
export interface Migration {
  // ファイル名の先頭から解析した連番（例: 1, 2, ...）。ゼロ埋めされていても
  // 数値として解釈される。
  version: number;
  name: string;
  sql: string;
}

// マイグレーションファイル名の命名規則: 数字 + 区切り文字（. _ -）+ 任意の名前
// + .sql。例: "0001_init.sql", "0002-add-owner.sql" など。
const MIGRATION_FILE_RE = /^(\d+)[._-].*\.sql$/;

/**
 * pg_advisory_lock 用の固定キー。複数のサーバープロセスが同時に起動しても
 * マイグレーション適用が直列化されるようにするためのもの。Hubble の
 * マイグレーション専用として決めた任意の定数値であり、他の用途とキーが
 * 衝突しないことだけが要件。
 */
const MIGRATION_ADVISORY_LOCK_KEY = 4_021_980_513;

// 指定ディレクトリからマイグレーションファイルを読み込み、ファイル名先頭の
// 数値プレフィックスの昇順にソートして返す。重複バージョンがあれば例外を
// 投げて早期に検出する。
export function loadMigrations(dir: string): Migration[] {
  // 命名規則に合致するファイルのみを対象にする（README 等は無視される）。
  const files = readdirSync(dir).filter((f) => MIGRATION_FILE_RE.test(f));
  const migrations = files.map((file) => {
    const match = MIGRATION_FILE_RE.exec(file);
    // 上の filter で正規表現にマッチすることは保証済みだが、TS の strict
    // モードを満たすためにフォールバック処理を書いている。
    const version = match ? Number.parseInt(match[1]!, 10) : NaN;
    return {
      version,
      name: file,
      sql: readFileSync(join(dir, file), 'utf8'),
    } satisfies Migration;
  });
  migrations.sort((a, b) => a.version - b.version);

  // 同じバージョン番号を持つファイルが複数あると適用順序が不定になるため、
  // ロード時点で検出してエラーにする。
  const seen = new Set<number>();
  for (const m of migrations) {
    if (seen.has(m.version)) {
      throw new Error(`Duplicate migration version ${m.version} (${m.name})`);
    }
    seen.add(m.version);
  }
  return migrations;
}

// schema_migrations テーブル（適用済みマイグレーションの記録用）が
// なければ作成する。CREATE TABLE IF NOT EXISTS なので何度呼んでも安全。
async function ensureMigrationsTable(db: SqlDatabase): Promise<void> {
  await db.run(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

// 既に適用済みのマイグレーションバージョンを昇順で返す。呼び出し前に
// schema_migrations テーブルの存在を保証する。
export async function appliedVersions(db: SqlDatabase): Promise<number[]> {
  await ensureMigrationsTable(db);
  const rows = await db.query<{ version: number }>(
    'SELECT version FROM schema_migrations ORDER BY version ASC',
  );
  // PostgreSQL は INTEGER 列を JS の number として返すが、入力境界で Number() を通す。
  return rows.map((r) => Number(r.version));
}

/**
 * 未適用のマイグレーションを順番に全て適用する。各マイグレーションは
 * `schema_migrations` への記録行 INSERT と同じトランザクション内で実行
 * されるため、SQL の適用と記録が食い違うことはない。PostgreSQL では、
 * この一連の処理全体をセッション単位の advisory lock で保護し、複数の
 * サーバープロセスが同時起動しても互いにマイグレーションを競合させない。
 * 新たに適用されたバージョンの一覧を返す。
 */
export async function runMigrations(db: SqlDatabase, migrations: Migration[]): Promise<number[]> {
  // PostgreSQLのadvisory lockで起動時のマイグレーション適用を直列化する。
  if (!hasAdvisoryLock(db)) {
    throw new Error('PostgreSQL database must provide migration advisory lock support');
  }
  return db.withAdvisoryLock(MIGRATION_ADVISORY_LOCK_KEY, () => applyMigrations(db, migrations));
}

// runMigrations() の本体。advisory lock の有無に関わらずここで実際の適用を行う。
async function applyMigrations(db: SqlDatabase, migrations: Migration[]): Promise<number[]> {
  await ensureMigrationsTable(db);
  // 既に適用済みのバージョンを Set にしておき、以降の判定を O(1) にする。
  const already = new Set(await appliedVersions(db));

  const applied: number[] = [];
  for (const migration of migrations) {
    // 適用済みならスキップ（冪等性の担保）。
    if (already.has(migration.version)) continue;
    await db.transaction(async (tx) => {
      // 1つのマイグレーションファイルには複数の SQL 文が含まれ得るため、
      // パラメータ無しのスクリプトとして exec() で一括実行する。
      await tx.exec(migration.sql);
      // SQL 適用の直後、同じトランザクション内で schema_migrations に
      // 記録行を追加する。これにより「SQL は成功したが記録は失敗した」
      // という不整合が起きない。
      await tx.run(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
        [migration.version, migration.name, new Date().toISOString()],
      );
    });
    applied.push(migration.version);
  }
  return applied;
}

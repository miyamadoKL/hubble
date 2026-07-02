/**
 * Minimal async SQL abstraction shared by the SQLite and PostgreSQL backends
 * (design.md §4, backend selection via DATABASE_URL / DB_PATH).
 *
 * All repository SQL is written with positional `?` placeholders and a flat
 * params array. The PostgreSQL adapter rewrites `?` to `$1..$n`; the SQLite
 * adapter passes them through to better-sqlite3 unchanged. Keep SQL free of
 * literal `?` characters inside string literals so the rewrite stays correct.
 *
 * SQLite / PostgreSQL の両バックエンドが共通で実装する、最小限の非同期 SQL
 * 抽象インターフェース（design.md §4、バックエンドの選択は DATABASE_URL /
 * DB_PATH で行う）。このファイルは型とインターフェースの定義のみを持ち、実装は
 * sqliteAdapter.ts / postgresAdapter.ts にある。
 *
 * store/ 配下のリポジトリ層は全て、位置指定の `?` プレースホルダとフラットな
 * パラメータ配列で SQL を書く（SQLite の記法に合わせている）。PostgreSQL
 * アダプター側で `?` を `$1..$n` へ書き換え、SQLite アダプター側は
 * better-sqlite3 にそのまま渡す。この変換が正しく機能するよう、SQL の
 * 文字列リテラル内に `?` を含めないこと。
 */
export type SqlDialect = 'sqlite' | 'postgres';

/** A bound parameter value. JSON payloads are passed as strings (TEXT columns). */
// バインドパラメータとして許容される値の型。JSON を保存する場合は
// JSON.stringify() した文字列として渡す（TEXT 列に保存される）。
export type SqlParam = string | number | boolean | null;

/**
 * SQLite / PostgreSQL に共通の非同期データベース操作インターフェース。
 * リポジトリ層（store/ 配下）やマイグレーション処理（migrate.ts）は、
 * 具体的なドライバではなくこのインターフェースだけに依存する。
 */
export interface SqlDatabase {
  /** どちらの方言のバックエンドで動作しているか。分岐が必要な箇所でのみ参照する。 */
  readonly dialect: SqlDialect;

  /** Run a query returning rows. `T` is the row shape (snake_case columns). */
  // 行を返すクエリ（主に SELECT）を実行する。`T` は列が snake_case の
  // 行オブジェクトの型で、呼び出し側が期待する形を型引数として渡す。
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;

  /** Run a single statement for its side effects (INSERT / UPDATE / DELETE). */
  // 副作用のための単一文（INSERT / UPDATE / DELETE）を実行する。戻り値の行は
  // 使わない場合に使う（行を受け取りたい場合は RETURNING 付きで query を使う）。
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;

  /**
   * Execute a multi-statement SQL script (no parameters), e.g. a migration
   * file. SQLite runs the whole string; PostgreSQL runs it as one simple-query
   * batch. Use `run` for single parameterized statements.
   *
   * パラメータを持たない、複数文から成る SQL スクリプト（マイグレーション
   * ファイルなど）を実行する。SQLite は文字列全体をそのまま実行し、
   * PostgreSQL は simple-query のバッチとして実行する。パラメータ付きの
   * 単一文を実行したい場合は `run` を使うこと。
   */
  exec(sql: string): Promise<void>;

  /**
   * Run `fn` inside a single transaction. The callback receives a database
   * handle bound to the transaction; statements issued through it are atomic.
   * Rolls back if `fn` throws.
   *
   * `fn` を1つのトランザクションの中で実行する。コールバックにはそのトラン
   * ザクションに束縛されたデータベースハンドルが渡され、それを通じて発行
   * された文は原子的（atomic）に扱われる。`fn` が例外を投げた場合はロール
   * バックされる。
   */
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;

  /** Close the underlying connection / pool. */
  // 内部のコネクション（SQLite の場合はファイルハンドル、PostgreSQL の場合は
  // コネクションプール）を閉じる。
  close(): Promise<void>;
}

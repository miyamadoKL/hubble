/**
 * server 全体の永続化層が依存する DB アクセスの共通契約を定義するファイル。
 *
 * `db/postgresAdapter.ts` がこのインターフェースを実装し、`store/*` の各
 * repository と `db/migrate.ts` は具象実装ではなくここで定義される
 * `SqlDatabase` にのみ依存する。永続化バックエンドは PostgreSQL に一本化されており
 * （旧 SQLite adapter や backend 分岐は撤去済み）、このファイルはその単一実装が
 * 満たすべき最小限の操作面（query/run/exec/transaction/close）だけを表す。
 */
// バインドパラメータとして許容される値の型。JSON を保存する場合は
// JSON.stringify() した文字列として渡す（TEXT 列に保存される）。
export type SqlParam = string | number | boolean | null;

/** repositoryとmigrationが依存するPostgreSQL用の非同期データベース操作。 */
export interface SqlDatabase {
  // 行を返すクエリ（主に SELECT）を実行する。`T` は列が snake_case の
  // 行オブジェクトの型で、呼び出し側が期待する形を型引数として渡す。
  query<T = Record<string, unknown>>(sql: string, params?: readonly SqlParam[]): Promise<T[]>;

  // 副作用のための単一文（INSERT / UPDATE / DELETE）を実行する。戻り値の行は
  // 使わない場合に使う（行を受け取りたい場合は RETURNING 付きで query を使う）。
  run(sql: string, params?: readonly SqlParam[]): Promise<void>;

  /** パラメータを持たないSQLスクリプトをsimple-queryのバッチとして実行する。 */
  exec(sql: string): Promise<void>;

  /**
   * `fn` を1つのトランザクションの中で実行する。コールバックにはそのトラン
   * ザクションに束縛されたデータベースハンドルが渡され、それを通じて発行
   * された文は原子的（atomic）に扱われる。`fn` が例外を投げた場合はロール
   * バックされる。
   */
  transaction<T>(fn: (tx: SqlDatabase) => Promise<T>): Promise<T>;

  /** 内部のPostgreSQL接続プールを閉じる。 */
  close(): Promise<void>;
}

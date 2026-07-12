/**
 * アプリ永続化用 PostgreSQL の期限設定。
 *
 * datasource の接続期限とは分離し、migration、repository、shutdown が同じ有限の
 * 期限に従うようにする。
 */

/** アプリ永続化用 PostgreSQL に適用する期限値。 */
export interface PostgresTimeouts {
  /** コネクション取得と新規接続を待つ上限。 */
  connectionMs: number;
  /** 単一 SQL 文の実行上限。 */
  statementMs: number;
  /** PostgreSQL のロック取得を待つ上限。 */
  lockMs: number;
  /** トランザクション内で SQL を発行せず待機できる上限。 */
  idleTransactionMs: number;
  /** BEGIN から COMMIT までのアプリケーション側の上限。 */
  transactionMs: number;
}

/** 環境変数未設定時に使う有限の期限値。 */
export const DEFAULT_POSTGRES_TIMEOUTS: Readonly<PostgresTimeouts> = {
  connectionMs: 10_000,
  statementMs: 30_000,
  lockMs: 10_000,
  idleTransactionMs: 30_000,
  transactionMs: 60_000,
};

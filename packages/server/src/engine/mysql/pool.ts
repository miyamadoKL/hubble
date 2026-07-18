/**
 * mysql2 コネクションプールの生成。
 */
import mysql from 'mysql2/promise';
import type { ResolvedMysqlDatasource } from '../../datasource/types';
import { resolveDatasourceConnectTimeoutMs } from '../../datasource/connectionOptions';

export type MysqlPool = mysql.Pool;
export type MysqlPoolFactory = (ds: ResolvedMysqlDatasource) => MysqlPool;

/**
 * 解決済み MySQL データソースからプールを構築する。
 * readOnly 時は接続確立フックで READ ONLY セッションを設定する(ガードレール。
 * 本気のアクセス制御は DB 権限で行う)。
 */
export function createMysqlPool(ds: ResolvedMysqlDatasource): MysqlPool {
  const ssl = ds.tls ? (ds.tlsCa !== undefined ? { ca: ds.tlsCa } : {}) : undefined;
  const pool = mysql.createPool({
    host: ds.host,
    port: ds.port,
    user: ds.username,
    password: ds.password,
    database: ds.database,
    connectionLimit: ds.maxConnections,
    connectTimeout: resolveDatasourceConnectTimeoutMs(),
    // BIGINT と DECIMAL は Number 化せず文字列で受け取り、桁落ちを防ぐ。
    supportBigNumbers: true,
    bigNumberStrings: true,
    rowsAsArray: true,
    ssl,
    waitForConnections: true,
  });
  if (ds.readOnly) {
    pool.on('connection', (conn) => {
      void conn.query('SET SESSION TRANSACTION READ ONLY');
    });
  }
  return pool;
}

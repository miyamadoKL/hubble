/**
 * node-postgres コネクションプールの生成。
 */
import pg from 'pg';
import type { ResolvedPostgresqlDatasource } from '../../datasource/types';
import { resolveDatasourceConnectTimeoutMs } from '../../datasource/connectionOptions';

const { Pool } = pg;

export type PgPool = InstanceType<typeof Pool>;
export type PgPoolFactory = (ds: ResolvedPostgresqlDatasource) => PgPool;

/**
 * 解決済み PostgreSQL データソースからプールを構築する。
 * readOnly は acquire 時に SET default_transaction_read_only = on を発行する
 * (statementClient / engine 側で実施。ガードレールであり境界ではない)。
 */
export function createPgPool(ds: ResolvedPostgresqlDatasource): PgPool {
  const ssl = ds.tls ? (ds.tlsCa !== undefined ? { ca: ds.tlsCa } : true) : undefined;
  return new Pool({
    host: ds.host,
    port: ds.port,
    user: ds.username,
    password: ds.password,
    database: ds.database,
    max: ds.maxConnections,
    connectionTimeoutMillis: resolveDatasourceConnectTimeoutMs(),
    ssl,
  });
}

/**
 * MySQL 向け StatementClient 模倣実装。
 *
 * QueryRegistry / SSE / CSV が Trino の start/advance ループをそのまま使えるよう、
 * TrinoStatementResponse 形のページを返す。実行状態は内部 Map で管理し、
 * 完了/失敗時は接続をプールへ返却し、キャンセル時は進行中クエリの接続を破棄する。
 */
import type { Connection } from 'mysql2';
import mysql, { type PoolConnection, type FieldPacket } from 'mysql2/promise';
import type { StatementClient } from '../types';
import type { TrinoColumn, TrinoRequestContext, TrinoSessionMutations } from '../../trino/types';
import { throwMysqlDriverError } from '../sql/errors';
import { batchSize, buildPage, nextQueryId } from '../sql/response';
import { RowStreamReader } from '../sql/streamReader';
import { acquireSqlResource, createSqlAbortError, raceSqlAbort } from '../sql/abort';
import type { MysqlPool } from './pool';

export interface MysqlStatementClientOptions {
  /** データソース既定の readOnly（プール返却時に戻す値）。 */
  datasourceReadOnly: boolean;
  /** この実行単位でセッション read only を強制するか。 */
  sessionReadOnly: boolean;
}

interface MysqlExecution {
  queryId: string;
  conn: PoolConnection;
  reader: RowStreamReader;
  columns?: TrinoColumn[];
  rowCount: number;
  released: boolean;
  /** チェックアウト時に read only を上書きしたか。 */
  sessionReadOnlyApplied: boolean;
}

const MYSQL_NUMERIC_TYPE_NAMES = new Map<number, string>([
  [mysql.Types.DECIMAL, 'decimal'],
  [mysql.Types.TINY, 'tinyint'],
  [mysql.Types.SHORT, 'smallint'],
  [mysql.Types.LONG, 'integer'],
  [mysql.Types.FLOAT, 'float'],
  [mysql.Types.DOUBLE, 'double'],
  [mysql.Types.LONGLONG, 'bigint'],
  [mysql.Types.INT24, 'integer'],
  [mysql.Types.NEWDECIMAL, 'decimal'],
]);

function fieldsToColumns(fields: FieldPacket[]): TrinoColumn[] {
  return fields.map((field) => {
    const typeCode = field.columnType ?? (typeof field.type === 'number' ? field.type : undefined);
    return {
      name: field.name,
      type:
        typeof field.type === 'string'
          ? field.type
          : (MYSQL_NUMERIC_TYPE_NAMES.get(typeCode ?? -1) ?? 'unknown'),
    };
  });
}

async function applyMysqlSessionReadOnly(conn: PoolConnection, readOnly: boolean): Promise<void> {
  await conn.query(
    readOnly ? 'SET SESSION TRANSACTION READ ONLY' : 'SET SESSION TRANSACTION READ WRITE',
  );
}

/**
 * MySQL プールを使った StatementClient を生成する。
 * @param pool - mysql2 プール(テストから差し替え可能)。
 * @param options - データソース既定 readOnly と実行単位の sessionReadOnly。
 * @returns StatementClient 実装。
 */
export function createMysqlStatementClient(
  pool: MysqlPool,
  options: MysqlStatementClientOptions,
): StatementClient {
  const executions = new Map<string, MysqlExecution>();

  const restoreAndReleaseConnection = async (
    conn: PoolConnection,
    sessionReadOnlyApplied: boolean,
  ): Promise<void> => {
    if (sessionReadOnlyApplied) {
      try {
        await applyMysqlSessionReadOnly(conn, options.datasourceReadOnly);
      } catch (err) {
        conn.destroy();
        throw err;
      }
    }
    conn.release();
  };

  const releaseExecution = async (exec: MysqlExecution, signal?: AbortSignal): Promise<void> => {
    if (exec.released) return;
    exec.reader.dispose();
    try {
      if (exec.sessionReadOnlyApplied) {
        await raceSqlAbort(
          applyMysqlSessionReadOnly(exec.conn, options.datasourceReadOnly),
          signal,
          () => {
            destroyExecution(exec);
          },
        );
      }
      if (exec.released) return;
      exec.released = true;
      executions.delete(exec.queryId);
      exec.conn.release();
    } catch (err) {
      if (!exec.released) destroyExecution(exec);
      throw err;
    }
  };

  /** キャンセル等で進行中クエリが残る接続はプールへ返さず破棄する。 */
  const destroyExecution = (exec: MysqlExecution): void => {
    if (exec.released) return;
    exec.released = true;
    executions.delete(exec.queryId);
    exec.reader.dispose();
    exec.conn.destroy();
  };

  const checkout = async (
    signal?: AbortSignal,
  ): Promise<{ conn: PoolConnection; sessionReadOnlyApplied: boolean }> => {
    const conn = await acquireSqlResource(pool.getConnection(), signal, (lateConnection) => {
      lateConnection.destroy();
    });
    let destroyed = false;
    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      conn.destroy();
    };
    try {
      let sessionReadOnlyApplied = false;
      if (options.sessionReadOnly && !options.datasourceReadOnly) {
        await raceSqlAbort(applyMysqlSessionReadOnly(conn, true), signal, destroy);
        sessionReadOnlyApplied = true;
      }
      return { conn, sessionReadOnlyApplied };
    } catch (err) {
      if (!destroyed) conn.destroy();
      throw err;
    }
  };

  return {
    async start(
      statement: string,
      _ctx: TrinoRequestContext,
      _mutations: TrinoSessionMutations,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) throw new Error('Aborted');
      const queryId = nextQueryId('mysql');
      let conn: PoolConnection | undefined;
      let sessionReadOnlyApplied = false;
      let reader: RowStreamReader | undefined;
      let ownsConnection = false;
      const destroyLocalExecution = (): void => {
        if (!conn || !ownsConnection) return;
        ownsConnection = false;
        reader?.dispose();
        conn.destroy();
      };
      try {
        ({ conn, sessionReadOnlyApplied } = await checkout(signal));
        ownsConnection = true;
        const rawConn = conn.connection as unknown as Connection;
        const stream = rawConn
          .query({ sql: statement, rowsAsArray: true })
          .stream({ highWaterMark: batchSize() });

        let columns: TrinoColumn[] | undefined;
        const fieldsReady = new Promise<void>((resolve, reject) => {
          stream.once('fields', (fields: FieldPacket[]) => {
            columns = fieldsToColumns(fields);
            resolve();
          });
          stream.once('error', reject);
          // fields が来ないクエリもある。
          setTimeout(resolve, 0);
        });
        await raceSqlAbort(fieldsReady, signal, destroyLocalExecution);

        reader = new RowStreamReader(stream, { batchSize: batchSize() });
        const { rows, done } = await raceSqlAbort(
          reader.readBatch(batchSize()),
          signal,
          destroyLocalExecution,
        );
        const exec: MysqlExecution = {
          queryId,
          conn,
          reader,
          columns,
          rowCount: rows.length,
          released: false,
          sessionReadOnlyApplied,
        };
        executions.set(queryId, exec);
        ownsConnection = false;
        conn = undefined;

        const nextUri = done ? undefined : queryId;
        if (done) await releaseExecution(exec, signal);
        return buildPage(queryId, columns, rows, nextUri, exec.rowCount);
      } catch (err) {
        reader?.dispose();
        if (conn && ownsConnection) {
          await restoreAndReleaseConnection(conn, sessionReadOnlyApplied).catch(() => {});
        }
        if (signal?.aborted) throw createSqlAbortError();
        throwMysqlDriverError(err);
      }
    },

    async advance(
      nextUri: string,
      _ctx: TrinoRequestContext,
      _mutations: TrinoSessionMutations,
      signal?: AbortSignal,
    ) {
      const exec = executions.get(nextUri);
      if (!exec) {
        return buildPage(nextUri, undefined, [], undefined, 0);
      }
      if (signal?.aborted) {
        destroyExecution(exec);
        throw createSqlAbortError();
      }
      try {
        const { rows, done } = await raceSqlAbort(
          exec.reader.readBatch(batchSize()),
          signal,
          () => {
            destroyExecution(exec);
          },
        );
        exec.rowCount += rows.length;
        const next = done ? undefined : nextUri;
        if (done) await releaseExecution(exec, signal);
        return buildPage(exec.queryId, undefined, rows, next, exec.rowCount);
      } catch (err) {
        if (!exec.released) await releaseExecution(exec);
        if (signal?.aborted) throw createSqlAbortError();
        throwMysqlDriverError(err);
      }
    },

    async cancel(nextUri: string, ctx: TrinoRequestContext): Promise<void> {
      void ctx;
      const exec = executions.get(nextUri);
      if (!exec) return;
      // 旧実装の別接続KILLは次の扱いだった。
      // ベストエフォート。
      // 現在は実行接続を同期的に破棄する。
      destroyExecution(exec);
    },

    async waitBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
      void attempt;
      void signal;
      // HTTP ポーリングではないため待機不要。
    },
  };
}

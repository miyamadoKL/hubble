/**
 * MySQL 向け StatementClient 模倣実装。
 *
 * QueryRegistry / SSE / CSV が Trino の start/advance ループをそのまま使えるよう、
 * TrinoStatementResponse 形のページを返す。実行状態は内部 Map で管理し、
 * 完了/失敗時は接続をプールへ返却し、キャンセル時は進行中クエリの接続を破棄する。
 */
import type { Connection } from 'mysql2';
import type { PoolConnection, FieldPacket } from 'mysql2/promise';
import type { StatementClient } from '../types';
import type { TrinoColumn, TrinoRequestContext, TrinoSessionMutations } from '../../trino/types';
import { throwMysqlDriverError } from '../sql/errors';
import { batchSize, buildPage, nextQueryId } from '../sql/response';
import { RowStreamReader } from '../sql/streamReader';
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
  threadId: number;
  rowCount: number;
  released: boolean;
  /** チェックアウト時に read only を上書きしたか。 */
  sessionReadOnlyApplied: boolean;
}

function fieldsToColumns(fields: FieldPacket[]): TrinoColumn[] {
  return fields.map((f) => ({
    name: f.name,
    type: typeof f.type === 'string' ? f.type : 'unknown',
  }));
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

  const restoreAndRelease = async (exec: MysqlExecution): Promise<void> => {
    if (exec.sessionReadOnlyApplied) {
      await applyMysqlSessionReadOnly(exec.conn, options.datasourceReadOnly);
    }
    exec.conn.release();
  };

  const releaseExecution = async (exec: MysqlExecution): Promise<void> => {
    if (exec.released) return;
    exec.released = true;
    executions.delete(exec.queryId);
    await restoreAndRelease(exec);
  };

  /** キャンセル等で進行中クエリが残る接続はプールへ返さず破棄する。 */
  const destroyExecution = async (exec: MysqlExecution): Promise<void> => {
    if (exec.released) return;
    exec.released = true;
    executions.delete(exec.queryId);
    exec.conn.destroy();
  };

  const checkout = async (): Promise<{ conn: PoolConnection; sessionReadOnlyApplied: boolean }> => {
    const conn = await pool.getConnection();
    let sessionReadOnlyApplied = false;
    if (options.sessionReadOnly && !options.datasourceReadOnly) {
      await applyMysqlSessionReadOnly(conn, true);
      sessionReadOnlyApplied = true;
    }
    return { conn, sessionReadOnlyApplied };
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
      try {
        ({ conn, sessionReadOnlyApplied } = await checkout());
        const threadId = conn.threadId ?? 0;
        const rawConn = conn.connection as unknown as Connection;
        const stream = rawConn
          .query({ sql: statement, rowsAsArray: true })
          .stream({ highWaterMark: batchSize() });

        let columns: TrinoColumn[] | undefined;
        await new Promise<void>((resolve, reject) => {
          stream.once('fields', (fields: FieldPacket[]) => {
            columns = fieldsToColumns(fields);
            resolve();
          });
          stream.once('error', reject);
          // fields が来ないクエリもある。
          setTimeout(resolve, 0);
        });

        const reader = new RowStreamReader(stream);
        const { rows, done } = await reader.readBatch(batchSize());
        const exec: MysqlExecution = {
          queryId,
          conn,
          reader,
          columns,
          threadId,
          rowCount: rows.length,
          released: false,
          sessionReadOnlyApplied,
        };
        executions.set(queryId, exec);
        conn = undefined;

        const nextUri = done ? undefined : queryId;
        return buildPage(queryId, columns, rows, nextUri, exec.rowCount);
      } catch (err) {
        if (conn) {
          if (sessionReadOnlyApplied) {
            await applyMysqlSessionReadOnly(conn, options.datasourceReadOnly).catch(() => {});
          }
          conn.release();
        }
        throwMysqlDriverError(err);
      }
    },

    async advance(
      nextUri: string,
      _ctx: TrinoRequestContext,
      _mutations: TrinoSessionMutations,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) throw new Error('Aborted');
      const exec = executions.get(nextUri);
      if (!exec) {
        return buildPage(nextUri, undefined, [], undefined, 0);
      }
      try {
        const { rows, done } = await exec.reader.readBatch(batchSize());
        exec.rowCount += rows.length;
        const next = done ? undefined : nextUri;
        if (done) await releaseExecution(exec);
        return buildPage(exec.queryId, undefined, rows, next, exec.rowCount);
      } catch (err) {
        await releaseExecution(exec);
        throwMysqlDriverError(err);
      }
    },

    async cancel(nextUri: string, ctx: TrinoRequestContext): Promise<void> {
      void ctx;
      const exec = executions.get(nextUri);
      if (!exec) return;
      let killer: PoolConnection | undefined;
      try {
        killer = await pool.getConnection();
        if (exec.threadId > 0) {
          await killer.query(`KILL QUERY ${exec.threadId}`);
        }
      } catch {
        // ベストエフォート。
      } finally {
        killer?.release();
        await destroyExecution(exec);
      }
    },

    async waitBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
      void attempt;
      void signal;
      // HTTP ポーリングではないため待機不要。
    },
  };
}

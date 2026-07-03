/**
 * MySQL 向け StatementClient 模倣実装。
 *
 * QueryRegistry / SSE / CSV が Trino の start/advance ループをそのまま使えるよう、
 * TrinoStatementResponse 形のページを返す。実行状態は内部 Map で管理し、
 * 完了/失敗/キャンセル時に必ず接続をプールへ返却する。
 */
import type { Connection } from 'mysql2';
import type { PoolConnection, FieldPacket } from 'mysql2/promise';
import type { StatementClient } from '../types';
import type { TrinoColumn, TrinoRequestContext, TrinoSessionMutations } from '../../trino/types';
import { throwMysqlDriverError } from '../sql/errors';
import { batchSize, buildPage, nextQueryId } from '../sql/response';
import { RowStreamReader } from '../sql/streamReader';
import type { MysqlPool } from './pool';

interface MysqlExecution {
  queryId: string;
  conn: PoolConnection;
  reader: RowStreamReader;
  columns?: TrinoColumn[];
  threadId: number;
  rowCount: number;
  released: boolean;
}

function fieldsToColumns(fields: FieldPacket[]): TrinoColumn[] {
  return fields.map((f) => ({
    name: f.name,
    type: typeof f.type === 'string' ? f.type : 'unknown',
  }));
}

/**
 * MySQL プールを使った StatementClient を生成する。
 * @param pool - mysql2 プール(テストから差し替え可能)。
 * @returns StatementClient 実装。
 */
export function createMysqlStatementClient(pool: MysqlPool): StatementClient {
  const executions = new Map<string, MysqlExecution>();

  const cleanup = async (exec: MysqlExecution): Promise<void> => {
    if (exec.released) return;
    exec.released = true;
    executions.delete(exec.queryId);
    exec.conn.release();
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
      try {
        conn = await pool.getConnection();
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
        };
        executions.set(queryId, exec);
        conn = undefined;

        const nextUri = done ? undefined : queryId;
        return buildPage(queryId, columns, rows, nextUri, exec.rowCount);
      } catch (err) {
        if (conn) conn.release();
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
        if (done) await cleanup(exec);
        return buildPage(exec.queryId, undefined, rows, next, exec.rowCount);
      } catch (err) {
        await cleanup(exec);
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
        await cleanup(exec);
      }
    },

    async waitBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
      void attempt;
      void signal;
      // HTTP ポーリングではないため待機不要。
    },
  };
}
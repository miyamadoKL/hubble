/**
 * PostgreSQL 向け StatementClient 模倣実装(pg-cursor 使用)。
 */
import Cursor from 'pg-cursor';
import type { PoolClient, FieldDef } from 'pg';
import type { StatementClient } from '../types';
import type { TrinoColumn, TrinoRequestContext, TrinoSessionMutations } from '../../trino/types';
import { throwPgDriverError } from '../sql/errors';
import { batchSize, buildPage, nextQueryId } from '../sql/response';
import type { PgPool } from './pool';

const PG_OID_TYPES: Record<number, string> = {
  16: 'boolean',
  20: 'bigint',
  21: 'smallint',
  23: 'integer',
  25: 'text',
  700: 'real',
  701: 'double precision',
  1043: 'varchar',
  1082: 'date',
  1114: 'timestamp',
  1184: 'timestamptz',
  1700: 'numeric',
};

interface PgExecution {
  queryId: string;
  client: PoolClient;
  cursor: Cursor;
  columns?: TrinoColumn[];
  backendPid: number;
  rowCount: number;
  released: boolean;
  readOnly: boolean;
}

function fieldsToColumns(fields: FieldDef[]): TrinoColumn[] {
  return fields.map((f) => ({
    name: f.name,
    type: PG_OID_TYPES[f.dataTypeID] ?? 'unknown',
  }));
}

function cursorFields(cursor: Cursor): FieldDef[] | undefined {
  const c = cursor as unknown as { _result?: { fields?: FieldDef[] } };
  return c._result?.fields;
}

/**
 * PostgreSQL プールを使った StatementClient を生成する。
 * @param pool - pg Pool(テストから差し替え可能)。
 * @param readOnly - 接続時に READ ONLY を設定するか。
 * @returns StatementClient 実装。
 */
export function createPgStatementClient(pool: PgPool, readOnly: boolean): StatementClient {
  const executions = new Map<string, PgExecution>();

  const cleanup = async (exec: PgExecution): Promise<void> => {
    if (exec.released) return;
    exec.released = true;
    executions.delete(exec.queryId);
    try {
      await exec.cursor.close();
    } catch {
      // ベストエフォート。
    }
    exec.client.release();
  };

  const acquire = async (): Promise<PoolClient> => {
    const client = await pool.connect();
    if (readOnly) {
      await client.query('SET default_transaction_read_only = on');
    }
    return client;
  };

  return {
    async start(
      statement: string,
      _ctx: TrinoRequestContext,
      _mutations: TrinoSessionMutations,
      signal?: AbortSignal,
    ) {
      if (signal?.aborted) throw new Error('Aborted');
      const queryId = nextQueryId('pg');
      let client: PoolClient | undefined;
      try {
        client = await acquire();
        const pidRes = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const backendPid = Number(pidRes.rows[0]?.pid ?? 0);
        const cursor = new Cursor(statement, undefined, { rowMode: 'array' });
        (client.query as (submittable: Cursor) => void)(cursor);
        const rows = (await cursor.read(batchSize())) as unknown[][];
        const fields = cursorFields(cursor);
        const columns = fields ? fieldsToColumns(fields) : undefined;
        const done = rows.length < batchSize();
        const exec: PgExecution = {
          queryId,
          client,
          cursor,
          columns,
          backendPid,
          rowCount: rows.length,
          released: false,
          readOnly,
        };
        executions.set(queryId, exec);
        client = undefined;

        const nextUri = done ? undefined : queryId;
        if (done) await cleanup(exec);
        return buildPage(queryId, columns, rows, nextUri, exec.rowCount);
      } catch (err) {
        client?.release();
        throwPgDriverError(err, statement);
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
        const rows = (await exec.cursor.read(batchSize())) as unknown[][];
        exec.rowCount += rows.length;
        const done = rows.length < batchSize();
        const next = done ? undefined : nextUri;
        if (done) await cleanup(exec);
        return buildPage(exec.queryId, undefined, rows, next, exec.rowCount);
      } catch (err) {
        await cleanup(exec);
        throwPgDriverError(err);
      }
    },

    async cancel(nextUri: string, ctx: TrinoRequestContext): Promise<void> {
      void ctx;
      const exec = executions.get(nextUri);
      if (!exec) return;
      let killer: PoolClient | undefined;
      try {
        killer = await pool.connect();
        if (exec.backendPid > 0) {
          await killer.query('SELECT pg_cancel_backend($1)', [exec.backendPid]);
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
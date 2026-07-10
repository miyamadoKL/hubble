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

export interface PgStatementClientOptions {
  /** データソース既定の readOnly（プール返却時に戻す値）。 */
  datasourceReadOnly: boolean;
  /** この実行単位でセッション read only を強制するか。 */
  sessionReadOnly: boolean;
}

interface PgExecution {
  queryId: string;
  client: PoolClient;
  cursor: Cursor;
  columns?: TrinoColumn[];
  backendPid: number;
  rowCount: number;
  released: boolean;
  /** チェックアウト時に read only を上書きしたか。 */
  sessionReadOnlyApplied: boolean;
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

async function applyPgSessionReadOnly(client: PoolClient, readOnly: boolean): Promise<void> {
  await client.query(`SET default_transaction_read_only = ${readOnly ? 'on' : 'off'}`);
}

/**
 * PostgreSQL プールを使った StatementClient を生成する。
 * @param pool - pg Pool(テストから差し替え可能)。
 * @param options - データソース既定 readOnly と実行単位の sessionReadOnly。
 * @returns StatementClient 実装。
 */
export function createPgStatementClient(
  pool: PgPool,
  options: PgStatementClientOptions,
): StatementClient {
  const executions = new Map<string, PgExecution>();

  const restoreAndReleaseClient = async (
    client: PoolClient,
    sessionReadOnlyApplied: boolean,
  ): Promise<void> => {
    if (sessionReadOnlyApplied) {
      try {
        await applyPgSessionReadOnly(client, options.datasourceReadOnly);
      } catch (err) {
        const reason = err instanceof Error ? err : new Error(String(err));
        client.release(reason);
        throw err;
      }
    }
    client.release();
  };

  const releaseExecution = async (exec: PgExecution): Promise<void> => {
    if (exec.released) return;
    exec.released = true;
    executions.delete(exec.queryId);
    try {
      await exec.cursor.close();
    } catch {
      // ベストエフォート。
    }
    await restoreAndReleaseClient(exec.client, exec.sessionReadOnlyApplied);
  };

  /** キャンセル等で portal が残る接続はプールへ返さず破棄する。 */
  const destroyExecution = async (exec: PgExecution, reason?: Error): Promise<void> => {
    if (exec.released) return;
    exec.released = true;
    executions.delete(exec.queryId);
    try {
      await exec.cursor.close();
    } catch {
      // ベストエフォート。
    }
    exec.client.release(reason ?? new Error('Query cancelled'));
  };

  const destroyClient = async (
    client: PoolClient,
    reason: unknown,
    applied: boolean,
  ): Promise<void> => {
    if (applied) {
      await applyPgSessionReadOnly(client, options.datasourceReadOnly).catch(() => {});
    }
    const err = reason instanceof Error ? reason : new Error(String(reason));
    client.release(err);
  };

  const acquire = async (): Promise<{ client: PoolClient; sessionReadOnlyApplied: boolean }> => {
    const client = await pool.connect();
    try {
      let sessionReadOnlyApplied = false;
      if (options.datasourceReadOnly) {
        await applyPgSessionReadOnly(client, true);
      } else if (options.sessionReadOnly) {
        await applyPgSessionReadOnly(client, true);
        sessionReadOnlyApplied = true;
      }
      return { client, sessionReadOnlyApplied };
    } catch (err) {
      const reason = err instanceof Error ? err : new Error(String(err));
      client.release(reason);
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
      const queryId = nextQueryId('pg');
      let client: PoolClient | undefined;
      let cursor: Cursor | undefined;
      let sessionReadOnlyApplied = false;
      try {
        ({ client, sessionReadOnlyApplied } = await acquire());
        const pidRes = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const backendPid = Number(pidRes.rows[0]?.pid ?? 0);
        cursor = new Cursor(statement, undefined, { rowMode: 'array' });
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
          sessionReadOnlyApplied,
        };
        executions.set(queryId, exec);
        client = undefined;

        const nextUri = done ? undefined : queryId;
        if (done) await releaseExecution(exec);
        return buildPage(queryId, columns, rows, nextUri, exec.rowCount);
      } catch (err) {
        if (cursor) {
          try {
            await cursor.close();
          } catch {
            // ベストエフォート。
          }
        }
        if (client) await destroyClient(client, err, sessionReadOnlyApplied);
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
        if (done) await releaseExecution(exec);
        return buildPage(exec.queryId, undefined, rows, next, exec.rowCount);
      } catch (err) {
        await releaseExecution(exec);
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

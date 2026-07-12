/**
 * PostgreSQL 向け StatementClient 模倣実装(pg-cursor 使用)。
 */
import Cursor from 'pg-cursor';
import type { PoolClient, FieldDef } from 'pg';
import type { StatementClient } from '../types';
import type { TrinoColumn, TrinoRequestContext, TrinoSessionMutations } from '../../trino/types';
import { throwPgDriverError } from '../sql/errors';
import { batchSize, buildPage, nextQueryId } from '../sql/response';
import { acquireSqlResource, createSqlAbortError, raceSqlAbort } from '../sql/abort';
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

  const releaseExecution = async (exec: PgExecution, signal?: AbortSignal): Promise<void> => {
    if (exec.released) return;
    try {
      await raceSqlAbort(exec.cursor.close(), signal, () => {
        destroyExecution(exec, createSqlAbortError());
      });
      if (exec.released) return;
      if (exec.sessionReadOnlyApplied) {
        await raceSqlAbort(
          applyPgSessionReadOnly(exec.client, options.datasourceReadOnly),
          signal,
          () => {
            destroyExecution(exec, createSqlAbortError());
          },
        );
      }
      if (exec.released) return;
      exec.released = true;
      executions.delete(exec.queryId);
      exec.client.release();
    } catch (err) {
      if (!exec.released) {
        const reason = err instanceof Error ? err : new Error(String(err));
        destroyExecution(exec, reason);
      }
      throw err;
    }
  };

  /** キャンセル等で portal が残る接続はプールへ返さず破棄する。 */
  const destroyExecution = (exec: PgExecution, reason?: Error): void => {
    if (exec.released) return;
    exec.released = true;
    executions.delete(exec.queryId);
    void exec.cursor.close().catch(() => undefined);
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

  const acquire = async (
    signal?: AbortSignal,
  ): Promise<{ client: PoolClient; sessionReadOnlyApplied: boolean }> => {
    const client = await acquireSqlResource(pool.connect(), signal, (lateClient) => {
      lateClient.release(createSqlAbortError());
    });
    let destroyed = false;
    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      client.release(createSqlAbortError());
    };
    try {
      let sessionReadOnlyApplied = false;
      if (options.datasourceReadOnly) {
        await raceSqlAbort(applyPgSessionReadOnly(client, true), signal, destroy);
      } else if (options.sessionReadOnly) {
        await raceSqlAbort(applyPgSessionReadOnly(client, true), signal, destroy);
        sessionReadOnlyApplied = true;
      }
      return { client, sessionReadOnlyApplied };
    } catch (err) {
      if (!destroyed) {
        const reason = err instanceof Error ? err : new Error(String(err));
        client.release(reason);
      }
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
      let ownsClient = false;
      const destroyLocalExecution = (): void => {
        if (!client || !ownsClient) return;
        ownsClient = false;
        void cursor?.close().catch(() => undefined);
        client.release(createSqlAbortError());
      };
      try {
        ({ client, sessionReadOnlyApplied } = await acquire(signal));
        ownsClient = true;
        cursor = new Cursor(statement, undefined, { rowMode: 'array' });
        (client.query as (submittable: Cursor) => void)(cursor);
        const rows = (await raceSqlAbort(
          cursor.read(batchSize()),
          signal,
          destroyLocalExecution,
        )) as unknown[][];
        const fields = cursorFields(cursor);
        const columns = fields ? fieldsToColumns(fields) : undefined;
        const done = rows.length < batchSize();
        const exec: PgExecution = {
          queryId,
          client,
          cursor,
          columns,
          rowCount: rows.length,
          released: false,
          sessionReadOnlyApplied,
        };
        executions.set(queryId, exec);
        ownsClient = false;
        client = undefined;

        const nextUri = done ? undefined : queryId;
        if (done) await releaseExecution(exec, signal);
        return buildPage(queryId, columns, rows, nextUri, exec.rowCount);
      } catch (err) {
        if (cursor && ownsClient) {
          try {
            await cursor.close();
          } catch {
            // ベストエフォート。
          }
        }
        if (client && ownsClient) await destroyClient(client, err, sessionReadOnlyApplied);
        if (signal?.aborted) throw createSqlAbortError();
        throwPgDriverError(err, statement);
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
        destroyExecution(exec, createSqlAbortError());
        throw createSqlAbortError();
      }
      try {
        const rows = (await raceSqlAbort(exec.cursor.read(batchSize()), signal, () => {
          destroyExecution(exec, createSqlAbortError());
        })) as unknown[][];
        exec.rowCount += rows.length;
        const done = rows.length < batchSize();
        const next = done ? undefined : nextUri;
        if (done) await releaseExecution(exec, signal);
        return buildPage(exec.queryId, undefined, rows, next, exec.rowCount);
      } catch (err) {
        if (!exec.released) await releaseExecution(exec);
        if (signal?.aborted) throw createSqlAbortError();
        throwPgDriverError(err);
      }
    },

    async cancel(nextUri: string, ctx: TrinoRequestContext): Promise<void> {
      void ctx;
      const exec = executions.get(nextUri);
      if (!exec) return;
      destroyExecution(exec);
    },

    async waitBackoff(attempt: number, signal?: AbortSignal): Promise<void> {
      void attempt;
      void signal;
      // HTTP ポーリングではないため待機不要。
    },
  };
}

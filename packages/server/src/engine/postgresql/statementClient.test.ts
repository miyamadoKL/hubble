/**
 * PostgreSQL StatementClient 模倣のユニットテスト(フェイクプール注入)。
 */
import { describe, it, expect } from 'vitest';
import type { FieldDef } from 'pg';
import { TrinoQueryError, TrinoTransportError } from '../../errors';
import { emptySessionMutations } from '../../trino/types';
import { SQL_BATCH_SIZE } from '../sql/constants';
import { createPgStatementClient } from './statementClient';
import type { PgPool } from './pool';

const FIELDS: FieldDef[] = [
  {
    name: 'n',
    tableID: 0,
    columnID: 0,
    dataTypeID: 23,
    dataTypeSize: 4,
    dataTypeModifier: -1,
    format: 'text',
  },
];

interface FakePgPoolOptions {
  batches?: unknown[][][];
  pidQueryError?: unknown;
  readError?: unknown;
  /** SET default_transaction_read_only 発行を記録する配列。 */
  sqlLog?: string[];
}

function makeFakePgPool(opts: FakePgPoolOptions = {}): { pool: PgPool; actions: string[] } {
  const actions: string[] = [];
  const batches = opts.batches ?? [[[1], [2], [3]]];
  let readCalls = 0;
  let batchIndex = 0;

  const pool = {
    connect: async () => ({
      query: (arg: unknown) => {
        if (typeof arg === 'string') {
          if (arg.startsWith('SET default_transaction_read_only')) opts.sqlLog?.push(arg);
          if (opts.pidQueryError) return Promise.reject(opts.pidQueryError);
          return Promise.resolve({ rows: [{ pid: 99 }] });
        }
        const cursor = arg as {
          read: (n: number) => Promise<unknown[][]>;
          close: () => Promise<void>;
          _result?: { fields: FieldDef[] };
        };
        cursor._result = { fields: FIELDS };
        cursor.read = async () => {
          readCalls += 1;
          if (opts.readError && readCalls > 1) throw opts.readError;
          if (opts.readError && batches[0]!.length === 0) throw opts.readError;
          return (batches[batchIndex++] ?? []) as unknown[][];
        };
        cursor.close = async () => {};
      },
      release: (err?: Error) => {
        actions.push(err ? 'destroy' : 'release');
      },
    }),
  } as unknown as PgPool;

  return { pool, actions };
}

describe('createPgStatementClient', () => {
  it('returns the first batch with columns and FINISHED when rows fit one page', async () => {
    const { pool } = makeFakePgPool();
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    const page = await client.start('SELECT 1', { source: 'test' }, emptySessionMutations());
    expect(page.columns).toEqual([{ name: 'n', type: 'integer' }]);
    expect(page.data).toEqual([[1], [2], [3]]);
    expect(page.nextUri).toBeUndefined();
    expect(page.stats?.state).toBe('FINISHED');
  });

  it('splits large result sets across advance pages', async () => {
    const full = Array.from({ length: SQL_BATCH_SIZE + 2 }, (_, i) => [i]);
    const batches = [full.slice(0, SQL_BATCH_SIZE), full.slice(SQL_BATCH_SIZE)];
    const { pool, actions } = makeFakePgPool({ batches });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });

    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    expect(first.data).toHaveLength(SQL_BATCH_SIZE);
    expect(first.nextUri).toBeDefined();
    expect(first.stats?.state).toBe('RUNNING');

    const second = await client.advance(
      first.nextUri!,
      { source: 'test' },
      emptySessionMutations(),
    );
    expect(second.data).toHaveLength(2);
    expect(second.nextUri).toBeUndefined();
    expect(second.stats?.state).toBe('FINISHED');
    expect(actions).toContain('release');
    expect(actions).not.toContain('destroy');
  });

  it('maps syntax errors to USER_ERROR with line number', async () => {
    const { pool } = makeFakePgPool({
      batches: [[]],
      readError: { code: '42601', message: 'syntax error', position: '8' },
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    const statement = 'SELECT\nBAD';
    await expect(
      client.start(statement, { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeInstanceOf(TrinoQueryError);
    await expect(
      client.start(statement, { source: 'test' }, emptySessionMutations()),
    ).rejects.toMatchObject({
      trino: {
        errorType: 'USER_ERROR',
        errorName: 'SYNTAX_ERROR',
        errorLocation: { lineNumber: 2, columnNumber: 1 },
      },
    });
  });

  it('maps connection failures to TrinoTransportError', async () => {
    const { pool } = makeFakePgPool({
      pidQueryError: { code: 'ECONNREFUSED', message: 'connect refused' },
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    await expect(
      client.start('SELECT 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeInstanceOf(TrinoTransportError);
  });

  it('destroys the execution connection on cancel instead of returning it to the pool', async () => {
    const full = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions } = makeFakePgPool({
      batches: [full.slice(0, SQL_BATCH_SIZE), full.slice(SQL_BATCH_SIZE)],
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });

    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    await client.cancel(first.nextUri!, { source: 'test' });

    expect(actions).toContain('destroy');
    // 実行接続は destroy、KILL 用の別接続だけ release。
    expect(actions.filter((a) => a === 'release').length).toBe(1);
    expect(actions.filter((a) => a === 'destroy').length).toBe(1);
  });

  it('destroys the connection when start fails after opening a cursor', async () => {
    const { pool, actions } = makeFakePgPool({
      batches: [[]],
      readError: { code: '42601', message: 'syntax error', position: '1' },
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });

    await expect(
      client.start('SELECT BAD', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeInstanceOf(TrinoQueryError);
    expect(actions).toContain('destroy');
    expect(actions).not.toContain('release');
  });

  it('is idempotent when cancel races with destroy', async () => {
    const full = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions } = makeFakePgPool({
      batches: [full.slice(0, SQL_BATCH_SIZE), full.slice(SQL_BATCH_SIZE)],
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });

    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    await Promise.all([
      client.cancel(first.nextUri!, { source: 'test' }),
      client.cancel(first.nextUri!, { source: 'test' }),
    ]);

    expect(actions.filter((a) => a === 'destroy').length).toBe(1);
  });

  it('applies and restores session read only on release after normal completion', async () => {
    const sqlLog: string[] = [];
    const full = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions } = makeFakePgPool({
      batches: [full.slice(0, SQL_BATCH_SIZE), full.slice(SQL_BATCH_SIZE)],
      sqlLog,
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: true,
    });
    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    await client.advance(first.nextUri!, { source: 'test' }, emptySessionMutations());

    expect(sqlLog).toEqual([
      'SET default_transaction_read_only = on',
      'SET default_transaction_read_only = off',
    ]);
    expect(actions).toContain('release');
  });

  it('restores session read only before destroy when start fails', async () => {
    const sqlLog: string[] = [];
    const { pool, actions } = makeFakePgPool({
      batches: [[]],
      readError: { code: '42601', message: 'syntax error', position: '1' },
      sqlLog,
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: true,
    });
    await expect(
      client.start('SELECT BAD', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeInstanceOf(TrinoQueryError);
    expect(sqlLog).toEqual([
      'SET default_transaction_read_only = on',
      'SET default_transaction_read_only = off',
    ]);
    expect(actions).toContain('destroy');
  });

  it('waitBackoff resolves immediately', async () => {
    const { pool } = makeFakePgPool();
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    await expect(client.waitBackoff(0)).resolves.toBeUndefined();
  });
});

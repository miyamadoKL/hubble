/**
 * MySQL StatementClient 模倣のユニットテスト(フェイクプール注入)。
 */
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import type { FieldPacket } from 'mysql2/promise';
import { TrinoQueryError, TrinoTransportError } from '../../errors';
import { emptySessionMutations } from '../../trino/types';
import { SQL_BATCH_SIZE } from '../sql/constants';
import { createMysqlStatementClient } from './statementClient';
import type { MysqlPool } from './pool';

const FIELDS = [{ name: 'n', type: 'LONG' }] as unknown as FieldPacket[];

interface FakePoolOptions {
  rows?: unknown[][];
  error?: unknown;
  threadId?: number;
}

function makeFakePool(opts: FakePoolOptions = {}): { pool: MysqlPool; actions: string[] } {
  const actions: string[] = [];
  const rows = opts.rows ?? [[1], [2], [3]];
  const pool = {
    getConnection: async () => ({
      threadId: opts.threadId ?? 77,
      connection: {
        query: () => ({
          stream: () => {
            const stream = new Readable({ objectMode: true, read() {} });
            queueMicrotask(() => {
              if (opts.error) {
                stream.emit('error', opts.error);
                return;
              }
              stream.emit('fields', FIELDS);
              for (const row of rows) stream.push(row);
              stream.push(null);
            });
            return stream;
          },
        }),
      },
      release: () => {
        actions.push('release');
      },
      destroy: () => {
        actions.push('destroy');
      },
      query: async (sql: string) => {
        if (sql.startsWith('KILL QUERY')) actions.push('kill');
      },
    }),
  } as unknown as MysqlPool;
  return { pool, actions };
}

describe('createMysqlStatementClient', () => {
  it('returns the first batch with columns and FINISHED when rows fit one page', async () => {
    const { pool } = makeFakePool({ rows: [[1], [2]] });
    const client = createMysqlStatementClient(pool);
    const page = await client.start('SELECT 1', { source: 'test' }, emptySessionMutations());
    expect(page.columns).toEqual([{ name: 'n', type: 'LONG' }]);
    expect(page.data).toEqual([[1], [2]]);
    expect(page.nextUri).toBeUndefined();
    expect(page.stats?.state).toBe('FINISHED');
  });

  it('splits large result sets across advance pages', async () => {
    const rows = Array.from({ length: SQL_BATCH_SIZE + 5 }, (_, i) => [i]);
    const { pool, actions } = makeFakePool({ rows });
    const client = createMysqlStatementClient(pool);

    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    expect(first.data).toHaveLength(SQL_BATCH_SIZE);
    expect(first.nextUri).toBeDefined();
    expect(first.stats?.state).toBe('RUNNING');

    const second = await client.advance(
      first.nextUri!,
      { source: 'test' },
      emptySessionMutations(),
    );
    expect(second.data).toHaveLength(5);
    expect(second.nextUri).toBeUndefined();
    expect(second.stats?.state).toBe('FINISHED');

    expect(actions).toContain('release');
    expect(actions).not.toContain('destroy');
  });

  it('maps syntax errors to USER_ERROR', async () => {
    const { pool } = makeFakePool({
      error: { errno: 1064, sqlMessage: 'syntax error at line 3' },
    });
    const client = createMysqlStatementClient(pool);
    await expect(
      client.start('SELEC 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeInstanceOf(TrinoQueryError);
    await expect(
      client.start('SELEC 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toMatchObject({
      trino: {
        errorType: 'USER_ERROR',
        errorLocation: { lineNumber: 3, columnNumber: 1 },
      },
    });
  });

  it('maps connection failures to TrinoTransportError', async () => {
    const { pool } = makeFakePool({
      error: { code: 'ECONNREFUSED', message: 'connect refused' },
    });
    const client = createMysqlStatementClient(pool);
    await expect(
      client.start('SELECT 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeInstanceOf(TrinoTransportError);
  });

  it('destroys the execution connection on cancel instead of returning it to the pool', async () => {
    const rows = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions } = makeFakePool({ rows, threadId: 77 });
    const client = createMysqlStatementClient(pool);

    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    await client.cancel(first.nextUri!, { source: 'test' });

    expect(actions).toContain('kill');
    expect(actions).toContain('destroy');
    // KILL 用の別接続だけ release し、実行中クエリの接続は destroy する。
    expect(actions.filter((a) => a === 'release').length).toBe(1);
    expect(actions.filter((a) => a === 'destroy').length).toBe(1);
  });

  it('is idempotent when cancel races with destroy', async () => {
    const rows = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions } = makeFakePool({ rows });
    const client = createMysqlStatementClient(pool);

    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    await Promise.all([
      client.cancel(first.nextUri!, { source: 'test' }),
      client.cancel(first.nextUri!, { source: 'test' }),
    ]);

    expect(actions.filter((a) => a === 'destroy').length).toBe(1);
  });

  it('waitBackoff resolves immediately', async () => {
    const { pool } = makeFakePool();
    const client = createMysqlStatementClient(pool);
    await expect(client.waitBackoff(0)).resolves.toBeUndefined();
  });
});

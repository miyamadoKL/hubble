/** アプリ永続化用 PostgreSQL pool の期限設定テスト。 */
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPostgresPool,
  PostgresTransactionTimeoutError,
  runPostgresTransaction,
} from './postgresAdapter';

afterEach(() => {
  vi.useRealTimers();
});

describe('createPostgresPool', () => {
  it('実 pg module の全コネクション設定へ有限の期限を渡す', async () => {
    const pool = createPostgresPool(
      'postgres://hubble:secret@127.0.0.1/hubble' +
        '?statement_timeout=1&lock_timeout=2&idle_in_transaction_session_timeout=3' +
        '&options=-c%20search_path%3Dapp%20-c%20statement_timeout%3D4',
      {
        connectionMs: 1200,
        statementMs: 2300,
        lockMs: 3400,
        idleTransactionMs: 4500,
        transactionMs: 5600,
      },
    );

    expect(pool.options.connectionTimeoutMillis).toBe(1200);
    expect(pool.options.statement_timeout).toBe(2300);
    expect((pool.options as pg.PoolConfig & { lock_timeout: number }).lock_timeout).toBe(3400);
    expect(pool.options.idle_in_transaction_session_timeout).toBe(4500);

    // 実際の pg Client が connectionString を再解決した後も、URL 内の値ではなく
    // アプリ設定の startup parameter が選ばれることを確かめる。
    const client = new pg.Client(pool.options);
    const parameters = (
      client as unknown as {
        connectionParameters: {
          statement_timeout: number;
          lock_timeout: number;
          idle_in_transaction_session_timeout: number;
          connect_timeout: number;
        };
      }
    ).connectionParameters;
    expect(parameters.statement_timeout).toBe(2300);
    expect(parameters.lock_timeout).toBe(3400);
    expect(parameters.idle_in_transaction_session_timeout).toBe(4500);
    expect(parameters.connect_timeout).toBe(1);
    expect((parameters as typeof parameters & { options: string }).options).toBe(
      '-c search_path=app -c statement_timeout=4 ' +
        '-c statement_timeout=2300 -c lock_timeout=3400 ' +
        '-c idle_in_transaction_session_timeout=4500',
    );

    await pool.end();
  });
});

describe('runPostgresTransaction', () => {
  it('callback が外部 Promise を待ち続けても期限で接続を破棄する', async () => {
    vi.useFakeTimers();
    const queries: string[] = [];
    const release = vi.fn();
    let resume: (() => void) | undefined;
    const external = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return { rows: [] };
      }),
      release,
    };

    const transaction = runPostgresTransaction(client, 100, async (executor) => {
      await external;
      await executor.query('UPDATE example SET value = 2', []);
      return 'late';
    });
    const rejected = transaction.then(
      () => undefined,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(100);

    const error = await rejected;
    expect(error).toBeInstanceOf(PostgresTransactionTimeoutError);
    expect(error).toMatchObject({
      name: 'PostgresTransactionTimeoutError',
      code: 'DATABASE_TRANSACTION_TIMEOUT',
      timeoutMs: 100,
    });
    expect(queries).toEqual(['BEGIN']);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);

    resume?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(queries).toEqual(['BEGIN']);
  });

  it('正常時は commit して接続を一度だけ pool へ返す', async () => {
    const queries: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return { rows: [] };
      }),
      release,
    };

    await expect(
      runPostgresTransaction(client, 1000, async (executor) => {
        await executor.query('INSERT INTO example VALUES (1)', []);
        return 'ok';
      }),
    ).resolves.toBe('ok');
    expect(queries).toEqual(['BEGIN', 'INSERT INTO example VALUES (1)', 'COMMIT']);
    expect(release).toHaveBeenCalledExactlyOnceWith();
  });

  it('callback の例外時は rollback して元の例外を返す', async () => {
    const queries: string[] = [];
    const release = vi.fn();
    const client = {
      query: vi.fn(async (text: string) => {
        queries.push(text);
        return { rows: [] };
      }),
      release,
    };
    const failure = new Error('callback failed');

    await expect(
      runPostgresTransaction(client, 1000, async (executor) => {
        await executor.query('UPDATE example SET value = 1', []);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(queries).toEqual(['BEGIN', 'UPDATE example SET value = 1', 'ROLLBACK']);
    expect(release).toHaveBeenCalledExactlyOnceWith();
  });

  it('callback 失敗後の rollback が止まっても同じ期限で接続を破棄する', async () => {
    vi.useFakeTimers();
    const queries: string[] = [];
    let rejectRollback: ((error: Error) => void) | undefined;
    let notifyRollbackStarted: (() => void) | undefined;
    const rollbackStarted = new Promise<void>((resolve) => {
      notifyRollbackStarted = resolve;
    });
    const release = vi.fn((destroy?: boolean) => {
      if (destroy) rejectRollback?.(new Error('connection destroyed'));
    });
    const client = {
      query: vi.fn((text: string) => {
        queries.push(text);
        if (text === 'ROLLBACK') {
          notifyRollbackStarted?.();
          return new Promise<{ rows: unknown[] }>((_resolve, reject) => {
            rejectRollback = reject;
          });
        }
        return Promise.resolve({ rows: [] });
      }),
      release,
    };
    const failure = new Error('callback failed');

    const transaction = runPostgresTransaction(client, 100, async () => {
      throw failure;
    });
    const rejected = transaction.then(
      () => undefined,
      (error: unknown) => error,
    );
    await rollbackStarted;
    expect(queries).toEqual(['BEGIN', 'ROLLBACK']);

    await vi.advanceTimersByTimeAsync(100);
    const error = await rejected;
    expect(error).toBeInstanceOf(PostgresTransactionTimeoutError);
    expect(error).toMatchObject({ code: 'DATABASE_TRANSACTION_TIMEOUT', timeoutMs: 100 });
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
});

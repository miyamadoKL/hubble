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
  /** getConnection を保留するゲート。 */
  connectionGate?: Promise<void>;
  /** fields 送信後の行送信を保留するゲート。 */
  rowsGate?: Promise<void>;
  /** fields の送信を通知する。 */
  onFields?: () => void;
  /** 最初のバッチ送信後に後続行を保留するゲート。 */
  afterFirstBatchGate?: Promise<void>;
  error?: unknown;
  threadId?: number;
  /** SET SESSION 発行を記録する配列。 */
  sqlLog?: string[];
  sessionSetupError?: unknown;
  sessionRestoreError?: unknown;
  /** READ WRITE への復元を保留するゲート。 */
  sessionRestoreGate?: Promise<void>;
  /** READ WRITE 復元の開始を通知する。 */
  onSessionRestore?: () => void;
}

function makeFakePool(opts: FakePoolOptions = {}): {
  pool: MysqlPool;
  actions: string[];
  connectionCount: () => number;
} {
  const actions: string[] = [];
  const rows = opts.rows ?? [[1], [2], [3]];
  let connections = 0;
  const pool = {
    getConnection: async () => {
      connections += 1;
      await opts.connectionGate;
      return {
        threadId: opts.threadId ?? 77,
        connection: {
          query: () => ({
            stream: () => {
              const stream = new Readable({ objectMode: true, read() {} });
              queueMicrotask(
                () =>
                  void (async () => {
                    if (opts.error) {
                      stream.emit('error', opts.error);
                      return;
                    }
                    stream.emit('fields', FIELDS);
                    opts.onFields?.();
                    await opts.rowsGate;
                    for (const [index, row] of rows.entries()) {
                      if (index === SQL_BATCH_SIZE) await opts.afterFirstBatchGate;
                      stream.push(row);
                    }
                    stream.push(null);
                  })(),
              );
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
          if (sql.startsWith('SET SESSION')) {
            opts.sqlLog?.push(sql);
            if (sql.endsWith('READ ONLY') && opts.sessionSetupError) {
              throw opts.sessionSetupError;
            }
            if (sql.endsWith('READ WRITE') && opts.sessionRestoreError) {
              throw opts.sessionRestoreError;
            }
            if (sql.endsWith('READ WRITE')) {
              opts.onSessionRestore?.();
              await opts.sessionRestoreGate;
            }
          }
          if (sql.startsWith('KILL QUERY')) actions.push('kill');
        },
      };
    },
  } as unknown as MysqlPool;
  return { pool, actions, connectionCount: () => connections };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 250): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

describe('createMysqlStatementClient', () => {
  it('returns the first batch with columns and FINISHED when rows fit one page', async () => {
    const { pool, actions } = makeFakePool({ rows: [[1], [2]] });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    const page = await client.start('SELECT 1', { source: 'test' }, emptySessionMutations());
    expect(page.columns).toEqual([{ name: 'n', type: 'LONG' }]);
    expect(page.data).toEqual([[1], [2]]);
    expect(page.nextUri).toBeUndefined();
    expect(page.stats?.state).toBe('FINISHED');
    expect(actions.filter((action) => action === 'release')).toHaveLength(1);
    expect(actions).not.toContain('destroy');
  });

  it('splits large result sets across advance pages', async () => {
    const rows = Array.from({ length: SQL_BATCH_SIZE + 5 }, (_, i) => [i]);
    const { pool, actions } = makeFakePool({ rows });
    const client = createMysqlStatementClient(pool, {
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
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
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
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    await expect(
      client.start('SELECT 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeInstanceOf(TrinoTransportError);
  });

  it('destroys the execution connection on cancel instead of returning it to the pool', async () => {
    const rows = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions, connectionCount } = makeFakePool({ rows, threadId: 77 });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });

    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    await client.cancel(first.nextUri!, { source: 'test' });

    expect(connectionCount()).toBe(1);
    expect(actions).toContain('destroy');
    expect(actions).not.toContain('kill');
    // 旧実装では次の条件を検証していた。
    // KILL 用の別接続だけ release し、実行中クエリの接続は destroy する。
    // 現在は別接続を取得せず、実行接続を直接destroyする。
    expect(actions.filter((a) => a === 'release').length).toBe(0);
    expect(actions.filter((a) => a === 'destroy').length).toBe(1);
  });

  it('stops on deadline while waiting for a pool connection and destroys a late connection', async () => {
    const connectionGate = deferred();
    const { pool, actions } = makeFakePool({ connectionGate: connectionGate.promise });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });

    const starting = client.start(
      'SELECT 1',
      { source: 'test' },
      emptySessionMutations(),
      AbortSignal.timeout(5),
    );
    const stopped = await settlesWithin(starting);
    connectionGate.resolve();
    await starting.catch(() => undefined);

    expect(stopped).toBe(true);
    expect(actions).toEqual(['destroy']);
  });

  it('aborts the first stream read and destroys the active connection', async () => {
    const rowsGate = deferred();
    const fieldsSent = deferred();
    const { pool, actions } = makeFakePool({
      rowsGate: rowsGate.promise,
      onFields: () => fieldsSent.resolve(),
    });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    const controller = new AbortController();

    const starting = client.start(
      'SELECT 1',
      { source: 'test' },
      emptySessionMutations(),
      controller.signal,
    );
    await fieldsSent.promise;
    controller.abort();
    const stopped = await settlesWithin(starting);
    rowsGate.resolve();
    await starting.catch(() => undefined);

    expect(stopped).toBe(true);
    expect(actions).toEqual(['destroy']);
  });

  it('aborts an in-flight advance stream read', async () => {
    const afterFirstBatchGate = deferred();
    const rows = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions } = makeFakePool({
      rows,
      afterFirstBatchGate: afterFirstBatchGate.promise,
    });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    const controller = new AbortController();

    const advancing = client.advance(
      first.nextUri!,
      { source: 'test' },
      emptySessionMutations(),
      controller.signal,
    );
    controller.abort();
    const stopped = await settlesWithin(advancing);
    afterFirstBatchGate.resolve();
    await advancing.catch(() => undefined);

    expect(stopped).toBe(true);
    expect(actions).toEqual(['destroy']);
  });

  it('aborts session cleanup before returning a single first page', async () => {
    const sessionRestoreGate = deferred();
    const sessionRestoreStarted = deferred();
    const { pool, actions } = makeFakePool({
      rows: [[1]],
      sessionRestoreGate: sessionRestoreGate.promise,
      onSessionRestore: () => sessionRestoreStarted.resolve(),
    });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: true,
    });
    const controller = new AbortController();

    const starting = client.start(
      'SELECT 1',
      { source: 'test' },
      emptySessionMutations(),
      controller.signal,
    );
    await sessionRestoreStarted.promise;
    controller.abort();
    const stopped = await settlesWithin(starting);
    sessionRestoreGate.resolve();
    await starting.catch(() => undefined);

    expect(stopped).toBe(true);
    expect(actions).toEqual(['destroy']);
  });

  it('is idempotent when cancel races with destroy', async () => {
    const rows = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions } = makeFakePool({ rows });
    const client = createMysqlStatementClient(pool, {
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
    const rows = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions } = makeFakePool({ rows, sqlLog });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: true,
    });
    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    await client.advance(first.nextUri!, { source: 'test' }, emptySessionMutations());

    expect(sqlLog).toEqual([
      'SET SESSION TRANSACTION READ ONLY',
      'SET SESSION TRANSACTION READ WRITE',
    ]);
    expect(actions).toContain('release');
  });

  it('restores session read only before release when start fails', async () => {
    const sqlLog: string[] = [];
    const { pool } = makeFakePool({
      error: { errno: 1064, sqlMessage: 'syntax error' },
      sqlLog,
    });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: true,
    });
    await expect(
      client.start('SELEC 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeInstanceOf(TrinoQueryError);
    expect(sqlLog).toEqual([
      'SET SESSION TRANSACTION READ ONLY',
      'SET SESSION TRANSACTION READ WRITE',
    ]);
  });

  it('destroys the connection when session read only setup fails', async () => {
    const { pool, actions } = makeFakePool({
      sessionSetupError: new Error('setup failed'),
    });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: true,
    });

    await expect(
      client.start('SELECT 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeDefined();
    expect(actions).toEqual(['destroy']);
  });

  it('destroys the connection when session read only restoration fails', async () => {
    const { pool, actions } = makeFakePool({
      rows: [[1]],
      sessionRestoreError: new Error('restore failed'),
    });
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: true,
    });

    await expect(
      client.start('SELECT 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeDefined();
    expect(actions).toEqual(['destroy']);
  });

  it('waitBackoff resolves immediately', async () => {
    const { pool } = makeFakePool();
    const client = createMysqlStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    await expect(client.waitBackoff(0)).resolves.toBeUndefined();
  });
});

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
  /** pool.connect を保留するゲート。 */
  connectGate?: Promise<void>;
  /** cursor.read を保留するゲート。 */
  readGate?: Promise<void>;
  /** cursor.read の呼び出し単位で保留するゲート。 */
  readGates?: Array<Promise<void> | undefined>;
  /** cursor.read の開始を通知する。 */
  onRead?: (call: number) => void;
  /** cursor.close を保留するゲート。 */
  closeGate?: Promise<void>;
  /** cursor.close の開始を通知する。 */
  onClose?: () => void;
  connectError?: unknown;
  readError?: unknown;
  /** SET default_transaction_read_only 発行を記録する配列。 */
  sqlLog?: string[];
  sessionSetupError?: unknown;
  sessionRestoreError?: unknown;
}

function makeFakePgPool(opts: FakePgPoolOptions = {}): {
  pool: PgPool;
  actions: string[];
  connectionCount: () => number;
} {
  const actions: string[] = [];
  const batches = opts.batches ?? [[[1], [2], [3]]];
  let readCalls = 0;
  let batchIndex = 0;
  let connections = 0;

  const pool = {
    connect: async () => {
      connections += 1;
      await opts.connectGate;
      if (opts.connectError) throw opts.connectError;
      return {
        query: (arg: unknown) => {
          if (typeof arg === 'string') {
            if (arg.startsWith('SET default_transaction_read_only')) {
              opts.sqlLog?.push(arg);
              if (arg.endsWith('on') && opts.sessionSetupError) {
                return Promise.reject(opts.sessionSetupError);
              }
              if (arg.endsWith('off') && opts.sessionRestoreError) {
                return Promise.reject(opts.sessionRestoreError);
              }
              return Promise.resolve({ rows: [] });
            }
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
            opts.onRead?.(readCalls);
            await (opts.readGates?.[readCalls - 1] ?? opts.readGate);
            if (opts.readError && readCalls > 1) throw opts.readError;
            if (opts.readError && batches[0]!.length === 0) throw opts.readError;
            return (batches[batchIndex++] ?? []) as unknown[][];
          };
          cursor.close = async () => {
            opts.onClose?.();
            await opts.closeGate;
          };
        },
        release: (err?: Error) => {
          actions.push(err ? 'destroy' : 'release');
        },
      };
    },
  } as unknown as PgPool;

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

describe('createPgStatementClient', () => {
  it('returns the first batch with columns and FINISHED when rows fit one page', async () => {
    const { pool, actions } = makeFakePgPool();
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });
    const page = await client.start('SELECT 1', { source: 'test' }, emptySessionMutations());
    expect(page.columns).toEqual([{ name: 'n', type: 'integer' }]);
    expect(page.data).toEqual([[1], [2], [3]]);
    expect(page.nextUri).toBeUndefined();
    expect(page.stats?.state).toBe('FINISHED');
    expect(actions.filter((action) => action === 'release')).toHaveLength(1);
    expect(actions).not.toContain('destroy');
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
      connectError: { code: 'ECONNREFUSED', message: 'connect refused' },
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
    const { pool, actions, connectionCount } = makeFakePgPool({
      batches: [full.slice(0, SQL_BATCH_SIZE), full.slice(SQL_BATCH_SIZE)],
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: false,
    });

    const first = await client.start('SELECT n', { source: 'test' }, emptySessionMutations());
    await client.cancel(first.nextUri!, { source: 'test' });

    expect(connectionCount()).toBe(1);
    expect(actions).toContain('destroy');
    // 旧実装では次の条件を検証していた。
    // 実行接続は destroy、KILL 用の別接続だけ release。
    // 現在は別接続を取得せず、実行接続を直接destroyする。
    expect(actions.filter((a) => a === 'release').length).toBe(0);
    expect(actions.filter((a) => a === 'destroy').length).toBe(1);
  });

  it('stops on deadline while waiting for a pool connection and destroys a late connection', async () => {
    const connectGate = deferred();
    const { pool, actions } = makeFakePgPool({ connectGate: connectGate.promise });
    const client = createPgStatementClient(pool, {
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
    connectGate.resolve();
    await starting.catch(() => undefined);

    expect(stopped).toBe(true);
    expect(actions).toEqual(['destroy']);
  });

  it('aborts the first cursor read and destroys the active connection', async () => {
    const readGate = deferred();
    const readStarted = deferred();
    const { pool, actions } = makeFakePgPool({
      readGate: readGate.promise,
      onRead: () => readStarted.resolve(),
    });
    const client = createPgStatementClient(pool, {
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
    await readStarted.promise;
    controller.abort();
    const stopped = await settlesWithin(starting);
    readGate.resolve();
    await starting.catch(() => undefined);

    expect(stopped).toBe(true);
    expect(actions).toEqual(['destroy']);
  });

  it('aborts an in-flight advance cursor read', async () => {
    const secondReadGate = deferred();
    const full = Array.from({ length: SQL_BATCH_SIZE + 1 }, (_, i) => [i]);
    const { pool, actions } = makeFakePgPool({
      batches: [full.slice(0, SQL_BATCH_SIZE), full.slice(SQL_BATCH_SIZE)],
      readGates: [undefined, secondReadGate.promise],
    });
    const client = createPgStatementClient(pool, {
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
    secondReadGate.resolve();
    await advancing.catch(() => undefined);

    expect(stopped).toBe(true);
    expect(actions).toEqual(['destroy']);
  });

  it('aborts cursor cleanup before returning a single first page', async () => {
    const closeGate = deferred();
    const closeStarted = deferred();
    const { pool, actions } = makeFakePgPool({
      batches: [[[1]]],
      closeGate: closeGate.promise,
      onClose: () => closeStarted.resolve(),
    });
    const client = createPgStatementClient(pool, {
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
    await closeStarted.promise;
    controller.abort();
    const stopped = await settlesWithin(starting);
    closeGate.resolve();
    await starting.catch(() => undefined);

    expect(stopped).toBe(true);
    expect(actions).toEqual(['destroy']);
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

  it('destroys the connection when session read only setup fails', async () => {
    const { pool, actions } = makeFakePgPool({
      sessionSetupError: new Error('setup failed'),
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: true,
    });

    await expect(
      client.start('SELECT 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeDefined();
    expect(actions).toEqual(['destroy']);
  });

  it('destroys the connection when session read only restoration fails', async () => {
    const { pool, actions } = makeFakePgPool({
      sessionRestoreError: new Error('restore failed'),
    });
    const client = createPgStatementClient(pool, {
      datasourceReadOnly: false,
      sessionReadOnly: true,
    });

    await expect(
      client.start('SELECT 1', { source: 'test' }, emptySessionMutations()),
    ).rejects.toBeDefined();
    expect(actions).toEqual(['destroy']);
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

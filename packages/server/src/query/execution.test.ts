import { describe, expect, it, vi } from 'vitest';
import type { QueryEvent } from '@hubble/contracts';
import type { QueryEngine, StatementClient } from '../engine/types';
import type { TrinoStatementResponse } from '../trino/types';
import { QueryExecution } from './execution';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function valueDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function executionWithObserver(onRows: (rows: unknown[][]) => void | Promise<void>): {
  exec: QueryExecution;
  advance: ReturnType<typeof vi.fn>;
} {
  const first: TrinoStatementResponse = {
    id: 'test-query',
    nextUri: 'https://trino.test/next/1',
    columns: [{ name: 'id', type: 'bigint' }],
    data: [[1]],
    stats: { state: 'RUNNING' },
  };
  const second: TrinoStatementResponse = {
    id: 'test-query',
    data: [[2]],
    stats: { state: 'FINISHED' },
  };
  const advance = vi.fn(async () => second);
  const client = {
    start: vi.fn(async () => first),
    advance,
    cancel: vi.fn(async () => undefined),
    waitBackoff: vi.fn(async () => undefined),
  } as unknown as StatementClient;
  const engine = {
    isClosed: () => false,
    downloadClient: () => client,
  } as unknown as QueryEngine;
  return {
    exec: new QueryExecution({
      queryId: 'qry_test',
      statement: 'SELECT id FROM test',
      ctx: {},
      datasourceId: 'trino-default',
      maxRows: 10,
      overflowMode: 'truncate',
      client,
      engine,
      resultObserver: { onRows },
    }),
    advance,
  };
}

describe('QueryExecution result observer backpressure', () => {
  it('emits and buffers rows before waiting, then delays the next page fetch', async () => {
    const persistenceStarted = deferred();
    const releasePersistence = deferred();
    let calls = 0;
    const { exec, advance } = executionWithObserver(async () => {
      calls += 1;
      if (calls === 1) {
        persistenceStarted.resolve();
        await releasePersistence.promise;
      }
    });
    const events: QueryEvent[] = [];
    exec.subscribe((event) => events.push(event));

    const running = exec.run();
    await persistenceStarted.promise;

    expect(exec.bufferedCount).toBe(1);
    expect(events).toContainEqual({ type: 'rows', offset: 0, rows: [[1]] });
    expect(advance).not.toHaveBeenCalled();

    releasePersistence.resolve();
    await running;
    expect(advance).toHaveBeenCalledOnce();
    expect(exec.state).toBe('finished');
    expect(exec.bufferedRows()).toEqual([[1], [2]]);
  });

  it('finishes the query when observer persistence rejects', async () => {
    const { exec } = executionWithObserver(async () => {
      throw new Error('persistence failed');
    });

    await exec.run();

    expect(exec.state).toBe('finished');
    expect(exec.error).toBeUndefined();
    expect(exec.bufferedRows()).toEqual([[1], [2]]);
  });
});

describe('QueryExecution cancellation around the first page', () => {
  it('stays canceled when a signal-ignoring client returns a single finished page', async () => {
    const firstPage = valueDeferred<TrinoStatementResponse>();
    const client = {
      start: vi.fn(() => firstPage.promise),
      advance: vi.fn(),
      cancel: vi.fn(async () => undefined),
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;
    const engine = {
      isClosed: () => false,
      downloadClient: () => client,
    } as unknown as QueryEngine;
    const exec = new QueryExecution({
      queryId: 'qry_first_page_cancel',
      statement: 'SELECT 1',
      ctx: {},
      datasourceId: 'postgresql',
      maxRows: 10,
      overflowMode: 'truncate',
      client,
      engine,
    });

    const running = exec.run();
    await exec.requestCancel();
    firstPage.resolve({
      id: 'driver-query',
      data: [[1]],
      stats: { state: 'FINISHED' },
    });
    await running;

    expect(exec.state).toBe('canceled');
    expect(exec.bufferedRows()).toEqual([]);
  });

  it('stays canceled when a signal-ignoring client returns its final advance page', async () => {
    const finalPage = valueDeferred<TrinoStatementResponse>();
    const advanceStarted = deferred();
    const client = {
      start: vi.fn(async () => ({
        id: 'driver-query',
        nextUri: 'driver-next',
        data: [[1]],
        stats: { state: 'RUNNING' },
      })),
      advance: vi.fn(() => {
        advanceStarted.resolve();
        return finalPage.promise;
      }),
      cancel: vi.fn(async () => undefined),
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;
    const engine = {
      isClosed: () => false,
      downloadClient: () => client,
    } as unknown as QueryEngine;
    const exec = new QueryExecution({
      queryId: 'qry_final_page_cancel',
      statement: 'SELECT 1',
      ctx: {},
      datasourceId: 'mysql',
      maxRows: 10,
      overflowMode: 'truncate',
      client,
      engine,
    });

    const running = exec.run();
    await advanceStarted.promise;
    await exec.requestCancel();
    finalPage.resolve({ id: 'driver-query', data: [[2]], stats: { state: 'FINISHED' } });
    await running;

    expect(exec.state).toBe('canceled');
    expect(exec.bufferedRows()).toEqual([[1]]);
  });

  it('stays canceled when Stop arrives during single-page observer backpressure', async () => {
    const observerStarted = deferred();
    const releaseObserver = deferred();
    const client = {
      start: vi.fn(async () => ({
        id: 'driver-query',
        data: [[1]],
        stats: { state: 'FINISHED' },
      })),
      advance: vi.fn(),
      cancel: vi.fn(async () => undefined),
      waitBackoff: vi.fn(async () => undefined),
    } as unknown as StatementClient;
    const engine = {
      isClosed: () => false,
      downloadClient: () => client,
    } as unknown as QueryEngine;
    const exec = new QueryExecution({
      queryId: 'qry_single_observer_cancel',
      statement: 'SELECT 1',
      ctx: {},
      datasourceId: 'postgresql',
      maxRows: 10,
      overflowMode: 'truncate',
      client,
      engine,
      resultObserver: {
        onRows: async () => {
          observerStarted.resolve();
          await releaseObserver.promise;
        },
      },
    });

    const running = exec.run();
    await observerStarted.promise;
    await exec.requestCancel();
    releaseObserver.resolve();
    await running;

    expect(exec.state).toBe('canceled');
  });

  it('stays canceled when Stop arrives during final advance observer backpressure', async () => {
    const observerStarted = deferred();
    const releaseObserver = deferred();
    let observedPages = 0;
    const { exec } = executionWithObserver(async () => {
      observedPages += 1;
      if (observedPages === 2) {
        observerStarted.resolve();
        await releaseObserver.promise;
      }
    });

    const running = exec.run();
    await observerStarted.promise;
    await exec.requestCancel();
    releaseObserver.resolve();
    await running;

    expect(exec.state).toBe('canceled');
    expect(exec.bufferedRows()).toEqual([[1], [2]]);
  });
});

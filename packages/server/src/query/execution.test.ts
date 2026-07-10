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

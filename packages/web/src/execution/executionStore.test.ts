import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock the API layer so the store never hits the network. createQuery resolves
// to a deterministic queryId; the others are inert.
const createQuery = vi.fn();
vi.mock('./api', () => ({
  createQuery: (...args: unknown[]) => createQuery(...args),
  cancelQuery: vi.fn().mockResolvedValue(undefined),
  fetchQuerySnapshot: vi.fn(),
  fetchQueryRows: vi.fn(),
  downloadCsvUrl: vi.fn(),
}));

import type { QueryEvent } from '@hue-fable/contracts';
import {
  useExecutionStore,
  __setEventSourceFactory,
  __setCellSettledSink,
  type CellResultSummary,
} from './executionStore';
import { MockEventSource } from './sse.test';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  MockEventSource.instances = [];
  createQuery.mockReset();
  __setEventSourceFactory((url) => new MockEventSource(url));
  // Reset store state between tests.
  useExecutionStore.setState({ cells: {} });
});

afterEach(() => {
  __setEventSourceFactory(undefined);
});

function lastSource(): MockEventSource {
  return MockEventSource.instances[MockEventSource.instances.length - 1]!;
}

const CTX = { catalog: 'tpch', schema: 'sf1' };
const OPTS = { autoLimit: false, limit: 5000 };

describe('executionStore.runUnit', () => {
  test('queues immediately, then streams SSE into the cell record', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-1' });
    const { runUnit } = useExecutionStore.getState();

    runUnit('cell-a', { text: 'SELECT 1', start: 0, end: 8 }, CTX, OPTS);

    // Optimistic queued state is set synchronously.
    expect(useExecutionStore.getState().cells['cell-a']?.state).toBe('queued');

    await flush(); // createQuery resolves → subscribe
    const src = lastSource();
    expect(src.url).toContain('qid-1');

    emit(src, { type: 'state', state: 'running' });
    emit(src, { type: 'columns', columns: [{ name: 'n', type: 'bigint' }] });
    emit(src, { type: 'rows', offset: 0, rows: [[1]] });
    emit(src, { type: 'done', state: 'finished', rowCount: 1, truncated: false });

    const cell = useExecutionStore.getState().cells['cell-a']!;
    expect(cell.queryId).toBe('qid-1');
    expect(cell.state).toBe('finished');
    expect(cell.columns).toEqual([{ name: 'n', type: 'bigint' }]);
    expect(cell.rows).toEqual([[1]]);
    expect(cell.rowCount).toBe(1);
    expect(cell.truncated).toBe(false);
    expect(cell.finishedAt).toBeDefined();
    expect(src.closed).toBe(true);
  });

  test('done event with truncated=true propagates to the cell record', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-trunc' });
    useExecutionStore.getState().runUnit('cell-trunc', unit('SELECT *'), CTX, OPTS);
    await flush();
    const src = lastSource();

    emit(src, { type: 'rows', offset: 0, rows: [[1]] });
    emit(src, { type: 'done', state: 'finished', rowCount: 100, truncated: true });

    const cell = useExecutionStore.getState().cells['cell-trunc']!;
    expect(cell.truncated).toBe(true);
    expect(cell.rowCount).toBe(100);
  });

  test('rows chunks append by offset (replay overlap tolerated)', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-2' });
    useExecutionStore.getState().runUnit('cell-b', unit('SELECT *'), CTX, OPTS);
    await flush();
    const src = lastSource();

    emit(src, { type: 'rows', offset: 0, rows: [[1], [2]] });
    emit(src, { type: 'rows', offset: 2, rows: [[3]] });
    // A replay chunk re-sending offset 0 must not duplicate.
    emit(src, { type: 'rows', offset: 0, rows: [[1], [2]] });
    emit(src, { type: 'done', state: 'finished', rowCount: 3, truncated: false });

    expect(useExecutionStore.getState().cells['cell-b']!.rows).toEqual([[1], [2], [3]]);
  });

  test('captures an error event with its detail', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-3' });
    useExecutionStore.getState().runUnit('cell-c', unit('SELECT bad'), CTX, OPTS);
    await flush();
    const src = lastSource();

    emit(src, {
      type: 'error',
      error: { code: 'TRINO_ERROR', message: 'no such table', trinoErrorName: 'TABLE_NOT_FOUND', line: 1, column: 15 },
    });
    emit(src, { type: 'done', state: 'failed', rowCount: 0, truncated: false });

    const cell = useExecutionStore.getState().cells['cell-c']!;
    expect(cell.state).toBe('failed');
    expect(cell.error?.trinoErrorName).toBe('TABLE_NOT_FOUND');
    expect(cell.error?.line).toBe(1);
  });

  test('a failed createQuery marks the cell failed', async () => {
    createQuery.mockRejectedValue(
      Object.assign(new Error('bad request'), {
        detail: { code: 'BAD_REQUEST', message: 'bad request' },
      }),
    );
    useExecutionStore.getState().runUnit('cell-d', unit('SELECT 1'), CTX, OPTS);
    await flush();
    const cell = useExecutionStore.getState().cells['cell-d']!;
    expect(cell.state).toBe('failed');
    expect(cell.error?.code).toBe('BAD_REQUEST');
  });
});

describe('executionStore generation guard (stale discard)', () => {
  test('re-running a cell discards the previous subscription’s events', async () => {
    createQuery.mockResolvedValueOnce({ queryId: 'old' }).mockResolvedValueOnce({ queryId: 'new' });

    const { runUnit } = useExecutionStore.getState();
    runUnit('cell-x', unit('SELECT 1'), CTX, OPTS);
    await flush();
    const oldSrc = lastSource();

    // Second run before the first finished — supersedes generation.
    runUnit('cell-x', unit('SELECT 2'), CTX, OPTS);
    await flush();
    const newSrc = lastSource();
    expect(newSrc).not.toBe(oldSrc);

    // Late events from the OLD source must be ignored entirely.
    emit(oldSrc, { type: 'rows', offset: 0, rows: [[999]] });
    emit(oldSrc, { type: 'done', state: 'finished', rowCount: 1, truncated: false });

    // New source drives the cell.
    emit(newSrc, { type: 'rows', offset: 0, rows: [[2]] });
    emit(newSrc, { type: 'done', state: 'finished', rowCount: 1, truncated: false });

    const cell = useExecutionStore.getState().cells['cell-x']!;
    expect(cell.queryId).toBe('new');
    expect(cell.rows).toEqual([[2]]);
  });

  test('cancel bumps the generation and ignores trailing server events', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-cancel' });
    const store = useExecutionStore.getState();
    store.runUnit('cell-z', unit('SELECT 1'), CTX, OPTS);
    await flush();
    const src = lastSource();
    emit(src, { type: 'state', state: 'running' });

    store.cancel('cell-z');
    expect(useExecutionStore.getState().cells['cell-z']!.state).toBe('canceled');

    // A late finished event from the server must NOT revert the canceled state.
    emit(src, { type: 'done', state: 'finished', rowCount: 5, truncated: false });
    expect(useExecutionStore.getState().cells['cell-z']!.state).toBe('canceled');
  });
});

describe('executionStore.runUnits (sequential batch)', () => {
  test('runs statements in order and stops at the first failure', async () => {
    createQuery
      .mockResolvedValueOnce({ queryId: 'b1' })
      .mockResolvedValueOnce({ queryId: 'b2' })
      .mockResolvedValueOnce({ queryId: 'b3' });

    const promise = useExecutionStore.getState().runUnits(
      'cell-batch',
      [unit('SELECT 1'), unit('SELECT 2'), unit('SELECT 3')],
      CTX,
      OPTS,
    );

    // Statement 1 finishes ok.
    await flush();
    emit(lastSource(), { type: 'done', state: 'finished', rowCount: 1, truncated: false });
    // Statement 2 fails → batch should stop, never starting statement 3.
    await flush();
    emit(lastSource(), { type: 'done', state: 'failed', rowCount: 0, truncated: false });
    await flush();

    await promise;
    // Only two createQuery calls — statement 3 was skipped.
    expect(createQuery).toHaveBeenCalledTimes(2);
    expect(useExecutionStore.getState().cells['cell-batch']!.state).toBe('failed');
  });

  test('auto-LIMIT is applied to the sent statement when enabled', async () => {
    createQuery.mockResolvedValue({ queryId: 'lim' });
    useExecutionStore.getState().runUnit(
      'cell-lim',
      unit('SELECT * FROM orders'),
      CTX,
      { autoLimit: true, limit: 5000 },
    );
    await flush();
    expect(createQuery).toHaveBeenCalledWith(
      expect.objectContaining({ statement: 'SELECT * FROM orders\nLIMIT 5000' }),
    );
  });
});

describe('executionStore cell-settled sink (resultMeta write-back)', () => {
  afterEach(() => __setCellSettledSink(undefined));

  test('emits a summary on a clean finish', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-sink' });
    const seen: Array<{ cellId: string; summary: CellResultSummary }> = [];
    __setCellSettledSink((cellId, summary) => seen.push({ cellId, summary }));

    useExecutionStore.getState().runUnit('cell-sink', unit('SELECT 1'), CTX, OPTS);
    await flush();
    const src = lastSource();
    emit(src, { type: 'columns', columns: [{ name: 'n', type: 'bigint' }] });
    emit(src, { type: 'rows', offset: 0, rows: [[1]] });
    emit(src, { type: 'done', state: 'finished', rowCount: 1, truncated: false });

    expect(seen).toHaveLength(1);
    expect(seen[0]!.cellId).toBe('cell-sink');
    expect(seen[0]!.summary.state).toBe('finished');
    expect(seen[0]!.summary.rowCount).toBe(1);
    expect(seen[0]!.summary.columnCount).toBe(1);
    expect(typeof seen[0]!.summary.finishedAt).toBe('string');
  });

  test('emits a summary with the error message when createQuery rejects', async () => {
    createQuery.mockRejectedValue(
      Object.assign(new Error('bad'), { detail: { code: 'BAD_REQUEST', message: 'bad' } }),
    );
    const seen: CellResultSummary[] = [];
    __setCellSettledSink((_id, summary) => seen.push(summary));

    useExecutionStore.getState().runUnit('cell-sink-fail', unit('SELECT 1'), CTX, OPTS);
    await flush();

    expect(seen).toHaveLength(1);
    expect(seen[0]!.state).toBe('failed');
    expect(seen[0]!.errorMessage).toBe('bad');
  });

  test('emits a summary on cancel', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-cancel-sink' });
    const seen: CellResultSummary[] = [];
    __setCellSettledSink((_id, summary) => seen.push(summary));

    useExecutionStore.getState().runUnit('cell-cancel-sink', unit('SELECT 1'), CTX, OPTS);
    await flush();
    useExecutionStore.getState().cancel('cell-cancel-sink');

    expect(seen.some((s) => s.state === 'canceled')).toBe(true);
  });
});

// ---- helpers ----------------------------------------------------------------

function unit(text: string) {
  return { text, start: 0, end: text.length };
}

function emit(src: MockEventSource, event: QueryEvent) {
  src.emit(event);
}

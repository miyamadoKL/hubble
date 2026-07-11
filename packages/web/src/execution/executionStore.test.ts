import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Mock the API layer so the store never hits the network. createQuery resolves
// to a deterministic queryId; the others are inert.
const createQuery = vi.fn();
const cancelQuery = vi.fn();
vi.mock('./api', () => ({
  createQuery: (...args: unknown[]) => createQuery(...args),
  cancelQuery: (...args: unknown[]) => cancelQuery(...args),
  fetchQuerySnapshot: vi.fn(),
  fetchQueryRows: vi.fn(),
  downloadCsvUrl: vi.fn(),
}));

import type { QueryEvent } from '@hubble/contracts';
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
  cancelQuery.mockReset().mockResolvedValue(undefined);
  __setEventSourceFactory((url) => new MockEventSource(url));
  __setCellSettledSink(undefined);
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
    emit(src, {
      type: 'done',
      state: 'finished',
      rowCount: 100,
      truncated: true,
      csvReexecAllowed: false,
    });

    const cell = useExecutionStore.getState().cells['cell-trunc']!;
    expect(cell.truncated).toBe(true);
    expect(cell.rowCount).toBe(100);
    expect(cell.csvReexecAllowed).toBe(false);
  });

  test('csvReexecAllowed from done event propagates to the cell record', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-reexec' });
    useExecutionStore.getState().runUnit('cell-reexec', unit('SELECT 1'), CTX, OPTS);
    await flush();
    const src = lastSource();

    emit(src, {
      type: 'done',
      state: 'finished',
      rowCount: 5,
      truncated: true,
      csvReexecAllowed: true,
    });

    const cell = useExecutionStore.getState().cells['cell-reexec']!;
    expect(cell.csvReexecAllowed).toBe(true);
  });

  test('rows chunks append by offset (replay overlap tolerated)', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-2' });
    useExecutionStore.getState().runUnit('cell-b', unit('SELECT *'), CTX, OPTS);
    await flush();
    const src = lastSource();

    emit(src, { type: 'rows', offset: 0, rows: [[1], [2]] });
    const first = useExecutionStore.getState().cells['cell-b']!;
    const rowsReference = first.rows;
    expect(first.rowsVersion).toBe(1);
    emit(src, { type: 'rows', offset: 2, rows: [[3]] });
    // A replay chunk re-sending offset 0 must not duplicate.
    emit(src, { type: 'rows', offset: 0, rows: [[10], [2]] });
    emit(src, { type: 'done', state: 'finished', rowCount: 3, truncated: false });

    const cell = useExecutionStore.getState().cells['cell-b']!;
    expect(cell.rows).toBe(rowsReference);
    expect(cell.rowsVersion).toBe(3);
    expect(cell.rows).toEqual([[10], [2], [3]]);
  });

  test('captures an error event with its detail', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-3' });
    useExecutionStore.getState().runUnit('cell-c', unit('SELECT bad'), CTX, OPTS);
    await flush();
    const src = lastSource();

    emit(src, {
      type: 'error',
      error: {
        code: 'TRINO_ERROR',
        message: 'no such table',
        trinoErrorName: 'TABLE_NOT_FOUND',
        line: 1,
        column: 15,
      },
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

    await store.cancel('cell-z');
    expect(useExecutionStore.getState().cells['cell-z']!.state).toBe('canceled');

    // A late finished event from the server must NOT revert the canceled state.
    emit(src, { type: 'done', state: 'finished', rowCount: 5, truncated: false });
    expect(useExecutionStore.getState().cells['cell-z']!.state).toBe('canceled');
  });

  test('cancel失敗時はrunningとSSE購読を維持し、後続イベントを反映する', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-cancel-failed' });
    cancelQuery.mockRejectedValue(new Error('cancel rejected'));
    const store = useExecutionStore.getState();
    store.runUnit('cell-cancel-failed', unit('SELECT 1'), CTX, OPTS);
    await flush();
    const src = lastSource();
    emit(src, { type: 'state', state: 'running' });

    await expect(store.cancel('cell-cancel-failed')).rejects.toThrow('cancel rejected');

    expect(src.closed).toBe(false);
    expect(useExecutionStore.getState().cells['cell-cancel-failed']).toMatchObject({
      state: 'running',
      error: { code: 'CANCEL_FAILED', message: 'cancel rejected' },
    });
    emit(src, { type: 'done', state: 'finished', rowCount: 1, truncated: false });
    expect(useExecutionStore.getState().cells['cell-cancel-failed']).toMatchObject({
      state: 'finished',
      error: undefined,
    });
  });

  test('cancel応答前にdoneが届いた場合はfinishedをcanceledで上書きしない', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-finished-race' });
    let resolveCancel!: () => void;
    cancelQuery.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const settledSink = vi.fn();
    __setCellSettledSink(settledSink);
    const store = useExecutionStore.getState();
    store.runUnit('cell-finished-race', unit('SELECT 1'), CTX, OPTS);
    await flush();

    const cancelPromise = store.cancel('cell-finished-race');
    emit(lastSource(), { type: 'done', state: 'finished', rowCount: 1, truncated: false });
    resolveCancel();
    await cancelPromise;

    expect(useExecutionStore.getState().cells['cell-finished-race']?.state).toBe('finished');
    expect(settledSink).toHaveBeenCalledTimes(1);
    __setCellSettledSink(undefined);
  });

  test('done先着後にcancelが失敗してもfinishedへCANCEL_FAILEDを残さない', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-finished-then-reject' });
    let rejectCancel!: (error: Error) => void;
    cancelQuery.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectCancel = reject;
        }),
    );
    const store = useExecutionStore.getState();
    store.runUnit('cell-finished-then-reject', unit('SELECT 1'), CTX, OPTS);
    await flush();

    const cancelPromise = store.cancel('cell-finished-then-reject');
    emit(lastSource(), { type: 'done', state: 'finished', rowCount: 1, truncated: false });
    rejectCancel(new Error('late cancel failure'));
    await expect(cancelPromise).rejects.toThrow('late cancel failure');

    expect(useExecutionStore.getState().cells['cell-finished-then-reject']).toMatchObject({
      state: 'finished',
      error: undefined,
    });
  });

  test('cancel失敗後の再cancel成功でCANCEL_FAILEDを消す', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-cancel-retry' });
    cancelQuery.mockRejectedValueOnce(new Error('first failed')).mockResolvedValueOnce(undefined);
    const store = useExecutionStore.getState();
    store.runUnit('cell-cancel-retry', unit('SELECT 1'), CTX, OPTS);
    await flush();

    await expect(store.cancel('cell-cancel-retry')).rejects.toThrow('first failed');
    expect(useExecutionStore.getState().cells['cell-cancel-retry']?.error?.code).toBe(
      'CANCEL_FAILED',
    );
    await store.cancel('cell-cancel-retry');

    expect(useExecutionStore.getState().cells['cell-cancel-retry']?.state).toBe('canceled');
    expect(useExecutionStore.getState().cells['cell-cancel-retry']?.error).toBeUndefined();
  });

  test('queryId確定前のcancelは作成完了後にサーバーへ停止要求を送る', async () => {
    let resolveCreate!: (value: { queryId: string }) => void;
    createQuery.mockImplementation(
      () =>
        new Promise<{ queryId: string }>((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const store = useExecutionStore.getState();
    store.runUnit('cell-early-cancel', unit('SELECT expensive'), CTX, OPTS);

    await store.cancel('cell-early-cancel');
    resolveCreate({ queryId: 'qid-created-late' });
    await flush();

    expect(cancelQuery).toHaveBeenCalledWith('qid-created-late');
    expect(useExecutionStore.getState().cells['cell-early-cancel']?.state).toBe('canceled');
  });

  test('不正SSEフレームをfailed終端として呼び出し元へ反映する', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-protocol-error' });
    useExecutionStore.getState().runUnit('cell-protocol-error', unit('SELECT 1'), CTX, OPTS);
    await flush();

    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    lastSource().emitRaw('done', '{broken-1');
    lastSource().emitRaw('done', '{broken-2');
    lastSource().emitRaw('done', '{broken-3');

    expect(useExecutionStore.getState().cells['cell-protocol-error']).toMatchObject({
      state: 'failed',
      error: { code: 'SSE_PROTOCOL_ERROR' },
    });
    expect(cancelQuery).toHaveBeenCalledWith('qid-protocol-error');
    log.mockRestore();
  });

  test('transport errorでは実行状態と購読を維持する', async () => {
    createQuery.mockResolvedValue({ queryId: 'qid-transport-error' });
    useExecutionStore.getState().runUnit('cell-transport-error', unit('SELECT 1'), CTX, OPTS);
    await flush();
    const source = lastSource();
    emit(source, { type: 'state', state: 'running' });

    source.fireError();

    expect(source.closed).toBe(false);
    const cell = useExecutionStore.getState().cells['cell-transport-error'];
    expect(cell?.state).toBe('running');
    expect(cell?.error).toBeUndefined();
  });

  test('failed済みでqueryIdが空のセルをcancelしても二重終端しない', async () => {
    createQuery.mockRejectedValue(new Error('create failed'));
    const settledSink = vi.fn();
    __setCellSettledSink(settledSink);
    useExecutionStore.getState().runUnit('cell-failed-cancel', unit('SELECT bad'), CTX, OPTS);
    await flush();

    await useExecutionStore.getState().cancel('cell-failed-cancel');

    expect(useExecutionStore.getState().cells['cell-failed-cancel']?.state).toBe('failed');
    expect(settledSink).toHaveBeenCalledTimes(1);
  });
});

describe('executionStore.runUnits (sequential batch)', () => {
  test('cancel要求が失敗しても後続statementを開始しない', async () => {
    createQuery.mockResolvedValue({ queryId: 'batch-cancel-failed' });
    cancelQuery.mockRejectedValue(new Error('cancel failed'));
    const batch = useExecutionStore
      .getState()
      .runUnits('cell-batch-cancel', [unit('SELECT 1'), unit('DELETE FROM t')], CTX, OPTS);
    await flush();

    await expect(useExecutionStore.getState().cancel('cell-batch-cancel')).rejects.toThrow(
      'cancel failed',
    );
    emit(lastSource(), { type: 'done', state: 'finished', rowCount: 1, truncated: false });
    await batch;

    expect(createQuery).toHaveBeenCalledTimes(1);
  });

  test('offlineでのStopはローカル終了して後続statementを開始しない', async () => {
    createQuery.mockResolvedValue({ queryId: 'batch-cancel-offline' });
    cancelQuery.mockRejectedValue(new TypeError('Failed to fetch'));
    const batch = useExecutionStore
      .getState()
      .runUnits('cell-batch-offline', [unit('SELECT 1'), unit('DELETE FROM t')], CTX, OPTS);
    await flush();

    await useExecutionStore.getState().cancel('cell-batch-offline');
    await batch;

    expect(useExecutionStore.getState().cells['cell-batch-offline']).toMatchObject({
      state: 'canceled',
      error: {
        code: 'CANCEL_OFFLINE',
        message: expect.stringContaining('server-side query may still be running'),
      },
    });
    expect(createQuery).toHaveBeenCalledTimes(1);
  });

  test('旧世代のcreate失敗は新世代batchのsettleを消費しない', async () => {
    let rejectOld!: (error: Error) => void;
    createQuery
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectOld = reject;
          }),
      )
      .mockResolvedValueOnce({ queryId: 'new-first' })
      .mockResolvedValueOnce({ queryId: 'new-second' });
    useExecutionStore.getState().runUnit('cell-stale-create', unit('SELECT old'), CTX, OPTS);
    const batch = useExecutionStore
      .getState()
      .runUnits('cell-stale-create', [unit('SELECT 1'), unit('SELECT 2')], CTX, OPTS);
    await flush();
    rejectOld(new Error('old failed'));
    await flush();

    expect(createQuery).toHaveBeenCalledTimes(2);
    emit(lastSource(), { type: 'done', state: 'finished', rowCount: 1, truncated: false });
    await flush();
    expect(createQuery).toHaveBeenCalledTimes(3);
    emit(lastSource(), { type: 'done', state: 'finished', rowCount: 1, truncated: false });
    await batch;
  });

  test('runs statements in order and stops at the first failure', async () => {
    createQuery
      .mockResolvedValueOnce({ queryId: 'b1' })
      .mockResolvedValueOnce({ queryId: 'b2' })
      .mockResolvedValueOnce({ queryId: 'b3' });

    const promise = useExecutionStore
      .getState()
      .runUnits('cell-batch', [unit('SELECT 1'), unit('SELECT 2'), unit('SELECT 3')], CTX, OPTS);

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
    useExecutionStore
      .getState()
      .runUnit('cell-lim', unit('SELECT * FROM orders'), CTX, { autoLimit: true, limit: 5000 });
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
    await useExecutionStore.getState().cancel('cell-cancel-sink');

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

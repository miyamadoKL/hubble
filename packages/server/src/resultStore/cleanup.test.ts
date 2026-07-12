/** Result expiry の定期実行で失敗を隔離し、次回を予約することを検証する。 */
import { describe, expect, it, vi } from 'vitest';
import type { HistoryRepository } from '../store/history';
import { ResultObjectDeletionRepository } from '../store/resultObjectDeletions';
import type { WorkflowRunRepository } from '../store/workflows';
import { openMemoryDatabase } from '../db';
import type { ResultStore } from './store';
import { ResultExpiryService } from './cleanup';

describe('ResultExpiryService periodic execution', () => {
  it('起動時の repository 失敗をログへ隔離して次回実行を予約する', async () => {
    const failure = new Error('repository unavailable');
    const callbacks: Array<() => void> = [];
    const clear = vi.fn();
    const logWarn = vi.fn();
    const service = new ResultExpiryService({
      history: {
        listExpiredResults: vi.fn().mockRejectedValue(failure),
      } as unknown as HistoryRepository,
      workflowRuns: {
        listExpiredResults: vi.fn().mockResolvedValue([]),
      } as unknown as WorkflowRunRepository,
      deletions: {
        claimDue: vi.fn().mockResolvedValue([]),
      } as unknown as ResultObjectDeletionRepository,
      resultStore: { enabled: true } as ResultStore,
      logWarn,
      setTimer: (callback) => {
        callbacks.push(callback);
        return { clear };
      },
    });

    service.start();
    await vi.waitFor(() =>
      expect(logWarn).toHaveBeenCalledWith('result expiry: periodic cleanup failed', failure),
    );
    expect(callbacks).toHaveLength(2);

    await service.stop();
    expect(clear).toHaveBeenCalledTimes(2);
  });

  it('1 分後の outbox timer で backoff 済みジョブを再試行する', async () => {
    const db = await openMemoryDatabase();
    const deletions = new ResultObjectDeletionRepository(db);
    const key = 'hubble-results/workflow/timer-retry.jsonl.gz';
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    await deletions.enqueue([key], new Date(now).toISOString());
    const failure = new Error('temporary failure');
    const deleteExpired = vi
      .fn<ResultStore['deleteExpired']>()
      .mockResolvedValueOnce({ deleted: [], failed: [{ key, error: failure }] })
      .mockResolvedValueOnce({ deleted: [key], failed: [] });
    const timers: Array<{ callback: () => void; ms: number; clear: ReturnType<typeof vi.fn> }> = [];
    const service = new ResultExpiryService({
      history: {
        listExpiredResults: vi.fn().mockResolvedValue([]),
        clearResultObjects: vi.fn().mockResolvedValue(undefined),
      } as unknown as HistoryRepository,
      workflowRuns: {
        listExpiredResults: vi.fn().mockResolvedValue([]),
        clearResultObjects: vi.fn().mockResolvedValue(undefined),
      } as unknown as WorkflowRunRepository,
      deletions,
      resultStore: { enabled: true, deleteExpired } as unknown as ResultStore,
      now: () => now,
      setTimer: (callback, ms) => {
        const clear = vi.fn();
        timers.push({ callback, ms, clear });
        return { clear };
      },
    });

    try {
      service.start();
      await vi.waitFor(() => expect(deleteExpired).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(timers.map((timer) => timer.ms).sort()).toEqual([60_000, 86_400_000]),
      );
      expect(await deletions.listForTest()).toEqual([
        expect.objectContaining({ nextAttemptAt: '2026-01-01T00:01:00.000Z' }),
      ]);

      now += 60_000;
      timers.find((timer) => timer.ms === 60_000)!.callback();
      await vi.waitFor(() => expect(deleteExpired).toHaveBeenCalledTimes(2));
      expect(await deletions.listForTest()).toEqual([]);
    } finally {
      await service.stop();
      await db.close();
    }
  });

  it('同一 key を一度だけ削除し、失敗後は backoff を経て再試行する', async () => {
    const db = await openMemoryDatabase();
    const deletions = new ResultObjectDeletionRepository(db);
    const key = 'hubble-results/workflow/retry.jsonl.gz';
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    await deletions.enqueue([key, key], new Date(now).toISOString());
    await deletions.enqueue([key], new Date(now).toISOString());
    const failure = new Error('object storage unavailable');
    const deleteExpired = vi
      .fn<ResultStore['deleteExpired']>()
      .mockResolvedValueOnce({ deleted: [], failed: [{ key, error: failure }] })
      .mockResolvedValueOnce({ deleted: [key], failed: [] });
    const logWarn = vi.fn();
    const history = {
      listExpiredResults: vi.fn().mockResolvedValue([]),
      clearResultObjects: vi.fn().mockResolvedValue(undefined),
    } as unknown as HistoryRepository;
    const workflowRuns = {
      listExpiredResults: vi.fn().mockResolvedValue([]),
      clearResultObjects: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowRunRepository;
    const service = new ResultExpiryService({
      history,
      workflowRuns,
      deletions,
      resultStore: { enabled: true, deleteExpired } as unknown as ResultStore,
      now: () => now,
      logWarn,
    });

    try {
      expect(await deletions.listForTest()).toHaveLength(1);
      await service.runOnce();
      expect(deleteExpired).toHaveBeenCalledWith([{ key }]);
      expect(await deletions.listForTest()).toEqual([
        expect.objectContaining({
          key,
          attempts: 1,
          nextAttemptAt: '2026-01-01T00:01:00.000Z',
          lastError: failure.message,
        }),
      ]);
      expect(logWarn).toHaveBeenCalledWith(`failed to delete expired result ${key}`, failure);

      await service.runOnce();
      expect(deleteExpired).toHaveBeenCalledOnce();

      now += 60_000;
      await service.runOnce();
      expect(deleteExpired).toHaveBeenCalledTimes(2);
      expect(await deletions.listForTest()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('通常の expiry と outbox が同じ key を参照しても削除を一回にまとめる', async () => {
    const db = await openMemoryDatabase();
    const deletions = new ResultObjectDeletionRepository(db);
    const key = 'hubble-results/shared.jsonl.gz';
    const nowIso = '2026-01-01T00:00:00.000Z';
    await deletions.enqueue([key], nowIso);
    const history = {
      listExpiredResults: vi.fn().mockResolvedValue([{ id: 'qry_1', resultObjectKey: key }]),
      clearResultObjects: vi.fn().mockResolvedValue(undefined),
    } as unknown as HistoryRepository;
    const workflowRuns = {
      listExpiredResults: vi.fn().mockResolvedValue([{ id: 'wfs_1', resultObjectKey: key }]),
      clearResultObjects: vi.fn().mockResolvedValue(undefined),
    } as unknown as WorkflowRunRepository;
    const deleteExpired = vi
      .fn<ResultStore['deleteExpired']>()
      .mockResolvedValue({ deleted: [key], failed: [] });
    const service = new ResultExpiryService({
      history,
      workflowRuns,
      deletions,
      resultStore: { enabled: true, deleteExpired } as unknown as ResultStore,
      now: () => Date.parse(nowIso),
    });

    try {
      await service.runOnce();
      expect(deleteExpired).toHaveBeenCalledWith([{ key }]);
      expect(history.clearResultObjects).toHaveBeenCalledWith([key]);
      expect(workflowRuns.clearResultObjects).toHaveBeenCalledWith([key]);
      expect(await deletions.listForTest()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('claim 上限を超える due job を同じ runOnce 内で drain する', async () => {
    const db = await openMemoryDatabase();
    const deletions = new ResultObjectDeletionRepository(db);
    const nowIso = '2026-01-01T00:00:00.000Z';
    const keys = Array.from(
      { length: 101 },
      (_, index) => `hubble-results/workflow/batch-${String(index).padStart(3, '0')}.jsonl.gz`,
    );
    await deletions.enqueue(keys, nowIso);
    const deleteExpired = vi
      .fn<ResultStore['deleteExpired']>()
      .mockImplementation(async (items) => ({
        deleted: items.map((item) => item.key),
        failed: [],
      }));
    const service = new ResultExpiryService({
      history: {
        listExpiredResults: vi.fn().mockResolvedValue([]),
        clearResultObjects: vi.fn().mockResolvedValue(undefined),
      } as unknown as HistoryRepository,
      workflowRuns: {
        listExpiredResults: vi.fn().mockResolvedValue([]),
        clearResultObjects: vi.fn().mockResolvedValue(undefined),
      } as unknown as WorkflowRunRepository,
      deletions,
      resultStore: { enabled: true, deleteExpired } as unknown as ResultStore,
      now: () => Date.parse(nowIso),
    });

    try {
      await service.runOnce();
      expect(deleteExpired).toHaveBeenCalledTimes(2);
      expect(deleteExpired.mock.calls[0]![0]).toHaveLength(100);
      expect(deleteExpired.mock.calls[1]![0]).toHaveLength(1);
      expect(await deletions.listForTest()).toEqual([]);
    } finally {
      await db.close();
    }
  });

  it('ResultStore 無効時は outbox を完了せず、再有効化が必要だと一度だけ警告する', async () => {
    const db = await openMemoryDatabase();
    const deletions = new ResultObjectDeletionRepository(db);
    const key = 'hubble-results/workflow/disabled.jsonl.gz';
    const nowIso = '2026-01-01T00:00:00.000Z';
    await deletions.enqueue([key], nowIso);
    const deleteExpired = vi.fn<ResultStore['deleteExpired']>();
    const logWarn = vi.fn();
    const service = new ResultExpiryService({
      history: {} as HistoryRepository,
      workflowRuns: {} as WorkflowRunRepository,
      deletions,
      resultStore: { enabled: false, deleteExpired } as unknown as ResultStore,
      now: () => Date.parse(nowIso),
      logWarn,
    });

    try {
      await service.runOnce();
      await service.runOnce();
      expect(deleteExpired).not.toHaveBeenCalled();
      expect(await deletions.listForTest()).toEqual([
        expect.objectContaining({ key, attempts: 0, lastError: null }),
      ]);
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn).toHaveBeenCalledWith(
        'result deletion outbox is pending while ResultStore is disabled; re-enable the original ResultStore to resume deletion',
      );
    } finally {
      await db.close();
    }
  });

  it('outbox key が live 行から参照されている場合は object を削除せず job を破棄する', async () => {
    const key = 'hubble-results/live.jsonl.gz';
    const complete = vi.fn(async () => undefined);
    const deleteExpired = vi.fn<ResultStore['deleteExpired']>();
    const service = new ResultExpiryService({
      history: {
        listExpiredResults: vi.fn().mockResolvedValue([]),
      } as unknown as HistoryRepository,
      workflowRuns: {
        listExpiredResults: vi.fn().mockResolvedValue([]),
      } as unknown as WorkflowRunRepository,
      deletions: {
        claimDue: vi
          .fn()
          .mockResolvedValueOnce([
            {
              key,
              attempts: 0,
              nextAttemptAt: '2026-01-01T00:00:00.000Z',
              lastError: null,
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ])
          .mockResolvedValue([]),
        isReferenced: vi.fn(async () => true),
        complete,
      } as unknown as ResultObjectDeletionRepository,
      resultStore: { enabled: true, deleteExpired } as unknown as ResultStore,
      now: () => Date.parse('2026-01-01T00:00:00.000Z'),
    });

    await service.runOnce();

    expect(deleteExpired).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith([key]);
  });
});

/** Result expiry の定期実行で失敗を隔離し、次回を予約することを検証する。 */
import { describe, expect, it, vi } from 'vitest';
import type { HistoryRepository } from '../store/history';
import type { WorkflowRunRepository } from '../store/workflows';
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
      workflowRuns: {} as WorkflowRunRepository,
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
    expect(callbacks).toHaveLength(1);

    await service.stop();
    expect(clear).toHaveBeenCalledOnce();
  });
});

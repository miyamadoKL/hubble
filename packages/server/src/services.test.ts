/**
 * Services の停止順序と所有資源の解放を検証する。
 */
import { describe, expect, it, vi } from 'vitest';
import { NotificationService } from './notification/service';
import { NoneResultStore } from './resultStore';
import { createTestContext } from './test/harness';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('Services shutdown', () => {
  it('一件が同期例外で失敗しても全資源を閉じ、DBを最後に一度だけ閉じる', async () => {
    const calls: string[] = [];
    const resultStoreGate = deferred();
    const resultStore = new NoneResultStore();
    const context = await createTestContext({ resultStore });
    const engine = [...context.services.engines.values()][0]!;
    const notifications = context.services.notifications as NotificationService;
    const engineError = new Error('engine close failed synchronously');
    const originalEngineClose = engine.close.bind(engine);
    const originalNotificationClose = notifications.close.bind(notifications);
    const originalDatabaseClose = context.db.close.bind(context.db);
    const closeEngine = vi.spyOn(engine, 'close').mockImplementation(() => {
      calls.push('engine');
      throw engineError;
    });
    const closeResultStore = vi.spyOn(resultStore, 'close').mockImplementation(async () => {
      calls.push('result-store-start');
      await resultStoreGate.promise;
      calls.push('result-store-end');
    });
    const closeNotifications = vi.spyOn(notifications, 'close').mockImplementation(async () => {
      calls.push('notifications');
    });
    const closeDatabase = vi.spyOn(context.db, 'close').mockImplementation(async () => {
      calls.push('database');
    });

    const first = context.services.shutdown();
    const observed = first.catch((error: unknown) => error);
    const second = context.services.shutdown();

    try {
      expect(second).toBe(first);
      await vi.waitFor(() => expect(closeResultStore).toHaveBeenCalledOnce());
      expect(closeEngine).toHaveBeenCalledOnce();
      expect(closeNotifications).toHaveBeenCalledOnce();
      expect(closeDatabase).not.toHaveBeenCalled();

      const firstCloseResources = context.services.closeResources();
      const secondCloseResources = context.services.closeResources();
      expect(secondCloseResources).toBe(firstCloseResources);

      resultStoreGate.resolve();
      const error = await observed;

      expect(error).toBeInstanceOf(AggregateError);
      expect(closeDatabase).toHaveBeenCalledOnce();
      expect(calls).toEqual([
        'engine',
        'result-store-start',
        'notifications',
        'result-store-end',
        'database',
      ]);
      const shutdownError = error as AggregateError;
      expect(shutdownError.message).toBe('Service shutdown failed');
      expect(shutdownError.errors).toHaveLength(1);
      expect(shutdownError.errors[0]).toBeInstanceOf(AggregateError);
      expect((shutdownError.errors[0] as AggregateError).errors).toContain(engineError);
    } finally {
      resultStoreGate.resolve();
      await observed;
      closeEngine.mockRestore();
      closeResultStore.mockRestore();
      closeNotifications.mockRestore();
      closeDatabase.mockRestore();
      await Promise.allSettled([
        originalEngineClose(),
        originalNotificationClose(),
        originalDatabaseClose(),
      ]);
    }
  });
});

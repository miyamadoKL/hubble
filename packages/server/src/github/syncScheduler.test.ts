import { describe, expect, it, vi } from 'vitest';
import type { GithubSyncService } from './syncService';
import { GithubSyncScheduler } from './syncScheduler';

describe('GithubSyncScheduler', () => {
  it('fires syncAll on timer and prevents overlapping runs', async () => {
    const syncAll = vi.fn(
      () =>
        new Promise<{
          updated: number;
          skippedModified: number;
          skippedNoToken: number;
          failed: number;
        }>((resolve) => {
          setTimeout(
            () => resolve({ updated: 1, skippedModified: 0, skippedNoToken: 0, failed: 0 }),
            20,
          );
        }),
    );
    const syncService = { syncAll } as unknown as GithubSyncService;
    let now = Date.parse('2026-01-01T03:00:00.000Z');
    const timers: Array<{ fn: () => void; at: number }> = [];
    const scheduler = new GithubSyncScheduler({
      syncService,
      syncCron: '* * * * *',
      now: () => now,
      setTimer: (fn, ms) => {
        timers.push({ fn, at: now + ms });
        return { clear: () => {} };
      },
    });

    scheduler.start();
    expect(timers).toHaveLength(1);

    now = timers[0]!.at;
    timers[0]!.fn();
    expect(syncAll).toHaveBeenCalledTimes(1);

    // 実行中に再発火しても 2 回目はスキップされる。
    timers[0]!.fn();
    expect(syncAll).toHaveBeenCalledTimes(1);

    await scheduler.stop();
    expect(syncAll).toHaveBeenCalledTimes(1);
  });

  it('does nothing when syncCron is null', () => {
    const syncAll = vi.fn();
    const scheduler = new GithubSyncScheduler({
      syncService: { syncAll } as unknown as GithubSyncService,
      syncCron: null,
    });
    scheduler.start();
    expect(syncAll).not.toHaveBeenCalled();
  });
});

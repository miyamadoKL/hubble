import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startFileReload } from './fileReload';

describe('startFileReload', () => {
  let mtimes: Map<string, number>;
  let reloadCalls: number;

  beforeEach(() => {
    mtimes = new Map([['/cfg/datasources.yaml', 1000]]);
    reloadCalls = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reloads when mtime changes on poll', async () => {
    const handle = startFileReload(
      [
        {
          path: '/cfg/datasources.yaml',
          reload: () => {
            reloadCalls += 1;
          },
        },
      ],
      { intervalSeconds: 30, statImpl: (p) => ({ mtimeMs: mtimes.get(p) ?? 0 }) },
    );
    mtimes.set('/cfg/datasources.yaml', 2000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reloadCalls).toBe(1);
    handle.stop();
  });

  it('reloads immediately on SIGHUP', async () => {
    const handle = startFileReload(
      [
        {
          path: '/cfg/datasources.yaml',
          reload: () => {
            reloadCalls += 1;
          },
        },
      ],
      { intervalSeconds: 0, statImpl: (p) => ({ mtimeMs: mtimes.get(p) ?? 0 }) },
    );
    process.emit('SIGHUP');
    await Promise.resolve();
    expect(reloadCalls).toBe(1);
    handle.stop();
  });
});

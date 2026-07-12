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
    await handle.stop();
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
    await handle.stop();
  });

  it('reloads when a missing file appears', async () => {
    const handle = startFileReload(
      [
        {
          path: '/cfg/rbac.yaml',
          reload: () => {
            reloadCalls += 1;
          },
        },
      ],
      {
        intervalSeconds: 30,
        statImpl: (p) => (mtimes.has(p) ? { mtimeMs: mtimes.get(p)! } : null),
      },
    );
    mtimes.set('/cfg/rbac.yaml', 1000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reloadCalls).toBe(1);
    await handle.stop();
  });

  it('warns once when a file disappears and does not reload', async () => {
    const warnings: string[] = [];
    const handle = startFileReload(
      [
        {
          path: '/cfg/datasources.yaml',
          reload: () => {
            reloadCalls += 1;
          },
        },
      ],
      {
        intervalSeconds: 30,
        statImpl: (p) => (mtimes.has(p) ? { mtimeMs: mtimes.get(p)! } : null),
        log: (m) => warnings.push(m),
      },
    );
    mtimes.delete('/cfg/datasources.yaml');
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reloadCalls).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('missing');
    await handle.stop();
  });

  it('reload 後に追加した secret file の変更を監視する', async () => {
    const reload = vi.fn();
    const handle = startFileReload([{ path: '/cfg/datasources.yaml', reload }], {
      intervalSeconds: 30,
      statImpl: (p) => (mtimes.has(p) ? { mtimeMs: mtimes.get(p)! } : null),
    });
    mtimes.set('/secret/password', 1000);
    handle.updateFiles([
      { path: '/cfg/datasources.yaml', reload },
      { path: '/secret/password', reload },
    ]);
    mtimes.set('/secret/password', 2000);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reload).toHaveBeenCalledTimes(1);
    await handle.stop();
  });

  it('停止時に進行中の reload を待ち、新しい reload を受け付けない', async () => {
    let finishReload: (() => void) | undefined;
    const reload = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishReload = resolve;
        }),
    );
    const handle = startFileReload([{ path: '/cfg/datasources.yaml', reload }], {
      intervalSeconds: 30,
      statImpl: (p) => ({ mtimeMs: mtimes.get(p) ?? 0 }),
    });

    handle.triggerReload();
    await Promise.resolve();
    expect(reload).toHaveBeenCalledTimes(1);

    let stopped = false;
    const firstStop = handle.stop();
    const duplicateStopping = handle.stop();
    expect(duplicateStopping).toBe(firstStop);
    const stopping = firstStop.then(() => {
      stopped = true;
    });
    process.emit('SIGHUP');
    handle.triggerReload();
    mtimes.set('/cfg/datasources.yaml', 2000);
    await vi.advanceTimersByTimeAsync(30_000);

    expect(stopped).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    finishReload?.();
    await Promise.all([stopping, duplicateStopping]);
    expect(stopped).toBe(true);
  });
});

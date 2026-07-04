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
    handle.stop();
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
    handle.stop();
  });
});

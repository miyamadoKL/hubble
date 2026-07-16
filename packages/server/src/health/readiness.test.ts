/** readiness probe の期限、共有、cache と依存障害の判定を検証する。 */
import { describe, expect, it, vi } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import type { QueryEngine } from '../engine/types';
import { ReadinessService } from './readiness';

function database(query: (...args: never[]) => Promise<unknown>): SqlDatabase {
  return {
    query: query as unknown as SqlDatabase['query'],
    run: vi.fn(),
    exec: vi.fn(),
    transaction: vi.fn(),
    close: vi.fn(),
  } as unknown as SqlDatabase;
}

function engine(probe: (...args: never[]) => Promise<unknown>): QueryEngine {
  return { probe: probe as unknown as QueryEngine['probe'] } as QueryEngine;
}

describe('ReadinessService', () => {
  it('DBと既定エンジンが成功した結果を期限内で再利用する', async () => {
    let now = 1_000;
    const query = vi.fn(async () => [{ ready: 1 }]);
    const probe = vi.fn(async () => undefined);
    const service = new ReadinessService({
      db: database(query),
      getDefaultEngine: () => engine(probe),
      now: () => now,
      cacheMs: 5_000,
    });

    await expect(service.check()).resolves.toEqual({
      ready: true,
      checks: { database: 'ok', defaultEngine: 'ok' },
    });
    now += 1_000;
    await service.check();

    expect(query).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('同時呼び出しで一つのprobeだけを共有する', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = vi.fn(async () => [{ ready: 1 }]);
    const probe = vi.fn(() => held);
    const service = new ReadinessService({
      db: database(query),
      getDefaultEngine: () => engine(probe),
    });

    const first = service.check();
    const second = service.check();
    release();
    await Promise.all([first, second]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('依存障害と期限超過をreadyとして扱わない', async () => {
    const failed = new ReadinessService({
      db: database(vi.fn(async () => Promise.reject(new Error('db down')))),
      getDefaultEngine: () => engine(vi.fn(async () => undefined)),
    });
    await expect(failed.check()).resolves.toMatchObject({
      ready: false,
      checks: { database: 'failed', defaultEngine: 'ok' },
    });

    const timedOut = new ReadinessService({
      db: database(vi.fn(() => new Promise<never>(() => undefined))),
      getDefaultEngine: () => engine(vi.fn(() => new Promise<never>(() => undefined))),
      timeoutMs: 5,
    });
    await expect(timedOut.check()).resolves.toEqual({
      ready: false,
      checks: { database: 'timeout', defaultEngine: 'timeout' },
    });
  });

  it('依存先が中止を無視しても期限超過後に新しいprobeを開始する', async () => {
    const query = vi.fn(() => new Promise<never>(() => undefined));
    const probe = vi.fn(() => new Promise<never>(() => undefined));
    const service = new ReadinessService({
      db: database(query),
      getDefaultEngine: () => engine(probe),
      timeoutMs: 5,
      cacheMs: 0,
    });

    await service.check();
    await service.check();

    expect(query).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('旧probeの遅延完了で新しい世代のcacheを上書きしない', async () => {
    let now = 1_000;
    let rejectFirstQuery!: (reason: Error) => void;
    let rejectFirstProbe!: (reason: Error) => void;
    const firstQuery = new Promise<never>((_resolve, reject) => {
      rejectFirstQuery = reject;
    });
    const firstProbe = new Promise<never>((_resolve, reject) => {
      rejectFirstProbe = reject;
    });
    const query = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => firstQuery)
      .mockResolvedValue([{ ready: 1 }]);
    const probe = vi
      .fn<() => Promise<unknown>>()
      .mockImplementationOnce(() => firstProbe)
      .mockResolvedValue(undefined);
    const service = new ReadinessService({
      db: database(query),
      getDefaultEngine: () => engine(probe),
      timeoutMs: 5,
      cacheMs: 5_000,
      now: () => now,
    });

    await expect(service.check()).resolves.toMatchObject({ ready: false });
    now += 5_001;
    await expect(service.check()).resolves.toMatchObject({ ready: true });

    rejectFirstQuery(new Error('late database failure'));
    rejectFirstProbe(new Error('late engine failure'));
    await Promise.resolve();
    await Promise.resolve();

    await expect(service.check()).resolves.toMatchObject({ ready: true });
    expect(query).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

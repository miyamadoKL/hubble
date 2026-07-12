// Query Guard 見積もりキャッシュの実行コンテキスト分離を検証する。
import type { EstimateResult } from '@hubble/contracts';
import { describe, expect, it, vi } from 'vitest';
import type { QueryEngine } from '../engine/types';
import { EstimateService, type EstimateRequestParams } from './estimateService';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const CONFIG = {
  mode: 'enforce',
  maxScanBytes: 1000,
  maxScanRows: 1000,
  onUnknown: 'block',
  estimateTimeoutMs: 3000,
  cacheTtlSeconds: 30,
  bytesPerSecond: 0,
} as const;

function estimateResult(marker: number, decision: 'allow' | 'block' = 'allow'): EstimateResult {
  return {
    status: 'estimated',
    scanBytes: marker,
    scanRows: marker,
    outputRows: marker,
    outputBytes: marker,
    estimatedSeconds: null,
    tables: [],
    verdict: { decision, reasons: decision === 'block' ? ['blocked by current engine'] : [] },
    elapsedMs: marker,
  };
}

function fakeEngine(
  datasourceId: string,
  marker: number,
  decision: 'allow' | 'block' = 'allow',
): {
  engine: QueryEngine;
  estimate: ReturnType<typeof vi.fn>;
} {
  const estimate = vi.fn(async () => estimateResult(marker, decision));
  const engine = {
    datasourceId,
    kind: 'trino',
    capabilities: { costEstimate: true, catalogs: true },
    estimate,
  } as unknown as QueryEngine;
  return { engine, estimate };
}

function request(over: Partial<EstimateRequestParams> = {}): EstimateRequestParams {
  return {
    datasourceId: 'ds',
    roleName: 'role',
    principal: 'alice',
    catalog: 'catalog',
    schema: 'schema',
    statement: 'SELECT 1',
    ...over,
  };
}

describe('EstimateService cache key', () => {
  const collisionPairs: Array<{
    name: string;
    first: EstimateRequestParams;
    second: EstimateRequestParams;
  }> = [
    {
      name: 'datasource and role',
      first: request({ datasourceId: 'ds one', roleName: 'role' }),
      second: request({ datasourceId: 'ds', roleName: 'one role' }),
    },
    {
      name: 'role and principal',
      first: request({ roleName: 'role one', principal: 'alice' }),
      second: request({ roleName: 'role', principal: 'one alice' }),
    },
    {
      name: 'principal and catalog',
      first: request({ principal: 'alice cat', catalog: 'catalog' }),
      second: request({ principal: 'alice', catalog: 'cat catalog' }),
    },
    {
      name: 'catalog and schema',
      first: request({ catalog: 'catalog one', schema: 'schema' }),
      second: request({ catalog: 'catalog', schema: 'one schema' }),
    },
    {
      name: 'schema and statement',
      first: request({ schema: 'schema SELECT', statement: '1' }),
      second: request({ schema: 'schema', statement: 'SELECT 1' }),
    },
    {
      name: 'missing and literal global role',
      first: request({ roleName: undefined }),
      second: request({ roleName: 'global' }),
    },
  ];

  it.each(collisionPairs)('separates $name boundaries', async ({ first, second }) => {
    const firstEngine = fakeEngine(first.datasourceId ?? 'ds', 1);
    const secondEngine =
      second.datasourceId === first.datasourceId
        ? firstEngine
        : fakeEngine(second.datasourceId ?? 'ds', 2);
    const engines = new Map<string, QueryEngine>([
      [first.datasourceId ?? 'ds', firstEngine.engine],
      [second.datasourceId ?? 'ds', secondEngine.engine],
    ]);
    const service = new EstimateService(engines, 'ds', CONFIG);

    await service.estimate(first);
    await service.estimate(second);
    await service.estimate(first);

    const calls =
      firstEngine.estimate.mock.calls.length +
      (secondEngine === firstEngine ? 0 : secondEngine.estimate.mock.calls.length);
    expect(calls).toBe(2);
  });

  it('separates cache entries after an engine generation is replaced', async () => {
    const first = fakeEngine('ds', 1);
    const second = fakeEngine('ds', 2);
    const engines = new Map<string, QueryEngine>([['ds', first.engine]]);
    const service = new EstimateService(engines, 'ds', CONFIG);

    expect((await service.estimate(request())).elapsedMs).toBe(1);
    engines.set('ds', second.engine);
    expect((await service.estimate(request())).elapsedMs).toBe(2);
    expect(first.estimate).toHaveBeenCalledTimes(1);
    expect(second.estimate).toHaveBeenCalledTimes(1);
  });

  it('invalidates only entries belonging to the requested datasource', async () => {
    const first = fakeEngine('ds', 1);
    const second = fakeEngine('other', 2);
    const engines = new Map<string, QueryEngine>([
      ['ds', first.engine],
      ['other', second.engine],
    ]);
    const service = new EstimateService(engines, 'ds', CONFIG);

    await service.estimate(request());
    await service.estimate(request({ datasourceId: 'other' }));
    service.invalidateDatasource('ds');
    await service.estimate(request());
    await service.estimate(request({ datasourceId: 'other' }));

    expect(first.estimate).toHaveBeenCalledTimes(2);
    expect(second.estimate).toHaveBeenCalledTimes(1);
  });

  it('does not restore an estimate that crossed datasource invalidation', async () => {
    const pending = deferred<EstimateResult>();
    const first = fakeEngine('ds', 1);
    first.engine.estimate = vi
      .fn()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValue(estimateResult(2));
    const engines = new Map<string, QueryEngine>([['ds', first.engine]]);
    const service = new EstimateService(engines, 'ds', CONFIG);

    const oldRequest = service.estimate(request());
    service.invalidateDatasource('ds');
    pending.resolve(estimateResult(1));
    await expect(oldRequest).resolves.toMatchObject({ elapsedMs: 2 });
    expect(service.getCached(request())).toMatchObject({ elapsedMs: 2 });

    await expect(service.estimate(request())).resolves.toMatchObject({ elapsedMs: 2 });
    expect(first.engine.estimate).toHaveBeenCalledTimes(2);
  });

  it('does not return an old allow verdict after the engine is replaced', async () => {
    const pending = deferred<EstimateResult>();
    const first = fakeEngine('ds', 1);
    first.engine.estimate = vi.fn(() => pending.promise);
    const second = fakeEngine('ds', 2, 'block');
    const engines = new Map<string, QueryEngine>([['ds', first.engine]]);
    const service = new EstimateService(engines, 'ds', CONFIG);

    const oldRequest = service.estimate(request());
    engines.set('ds', second.engine);
    pending.resolve(estimateResult(1));
    await expect(oldRequest).resolves.toMatchObject({
      elapsedMs: 2,
      verdict: { decision: 'block' },
    });

    await expect(service.estimate(request())).resolves.toMatchObject({ elapsedMs: 2 });
    expect(first.engine.estimate).toHaveBeenCalledOnce();
    expect(second.estimate).toHaveBeenCalledOnce();
  });

  it('fails closed when the datasource generation changes during both attempts', async () => {
    const firstPending = deferred<EstimateResult>();
    const secondPending = deferred<EstimateResult>();
    const engine = fakeEngine('ds', 1);
    engine.engine.estimate = vi
      .fn()
      .mockImplementationOnce(() => firstPending.promise)
      .mockImplementationOnce(() => secondPending.promise);
    const engines = new Map<string, QueryEngine>([['ds', engine.engine]]);
    const service = new EstimateService(engines, 'ds', CONFIG);

    const estimating = service.estimate(request());
    service.invalidateDatasource('ds');
    firstPending.resolve(estimateResult(1));
    await vi.waitFor(() => expect(engine.engine.estimate).toHaveBeenCalledTimes(2));
    service.invalidateDatasource('ds');
    secondPending.resolve(estimateResult(2));

    await expect(estimating).rejects.toMatchObject({
      status: 503,
      detail: { code: 'DATASOURCE_RELOADING' },
    });
  });
});

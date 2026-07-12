/**
 * `MetadataService`（packages/server/src/metadata/service.ts）の
 * TTL + stale-while-revalidate キャッシュ挙動を検証するテストスイート。
 * 実際の Trino には接続せず、呼び出し回数を数える `FakeEngine` を
 * QueryEngine の代わりに注入し、時刻も `clock` オブジェクトで
 * 制御することで TTL 境界を決定的にテストする。
 */
import { describe, it, expect } from 'vitest';
import type { Catalog, DatasourceKind } from '@hubble/contracts';
import { MetadataService } from './service';
import type { MetadataOptions, QueryEngine } from '../engine/types';

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A counting fake engine with controllable results. */
class FakeEngine implements QueryEngine {
  async probe(): Promise<void> {}
  readonly datasourceId = 'test-ds';
  readonly kind: DatasourceKind = 'trino';
  readonly capabilities = { costEstimate: true, catalogs: true };

  catalogCalls = 0;
  schemaCalls = 0;
  catalogs: Catalog[] = [{ name: 'tpch' }];
  /** 次の listCatalogs 呼び出しを1回だけ失敗させるフラグ。 */
  failNext = false;

  executionClient(): never {
    throw new Error('not used');
  }
  downloadClient(): never {
    throw new Error('not used');
  }
  async estimate(): Promise<never> {
    throw new Error('not used');
  }
  async validate(): Promise<{ ok: true }> {
    return { ok: true };
  }
  async listCatalogs(opts: MetadataOptions): Promise<Catalog[]> {
    this.lastPrincipal = opts.principal;
    this.catalogCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve(this.catalogs);
  }
  async listSchemas(_catalog: string, opts: MetadataOptions): Promise<{ name: string }[]> {
    this.lastPrincipal = opts.principal;
    this.schemaCalls += 1;
    return Promise.resolve([{ name: 's1' }]);
  }
  async listTables(): Promise<never> {
    throw new Error('not used');
  }
  async describeTable(): Promise<never> {
    throw new Error('not used');
  }
  async sampleTable(): Promise<never> {
    throw new Error('not used');
  }

  lastPrincipal?: string;
  async close(): Promise<void> {}
  isClosed(): boolean {
    return false;
  }
}

const PRINCIPAL = 'alice';

function svc(engine: FakeEngine, ttlMs: number, clock: { t: number }): MetadataService {
  const engines = new Map<string, QueryEngine>([[engine.datasourceId, engine]]);
  return new MetadataService(engines, engine.datasourceId, ttlMs, () => clock.t);
}

describe('MetadataService TTL', () => {
  it('serves live on miss, cache on hit within TTL', async () => {
    const engine = new FakeEngine();
    const clock = { t: 1000 };
    const service = svc(engine, 5000, clock);

    const first = await service.getCatalogs(PRINCIPAL);
    expect(first.source).toBe('live');
    expect(first.stale).toBe(false);
    expect(engine.catalogCalls).toBe(1);
    expect(engine.lastPrincipal).toBe(PRINCIPAL);

    clock.t += 1000; // within TTL
    const second = await service.getCatalogs(PRINCIPAL);
    expect(second.source).toBe('cache');
    expect(second.stale).toBe(false);
    expect(engine.catalogCalls).toBe(1); // no re-fetch
  });
});

describe('MetadataService stale-while-revalidate', () => {
  it('serves stale immediately then refreshes in the background', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 1000, clock);

    await service.getCatalogs(PRINCIPAL); // populate
    expect(engine.catalogCalls).toBe(1);

    clock.t += 5000; // now stale
    engine.catalogs = [{ name: 'tpch' }, { name: 'mysql' }];
    const stale = await service.getCatalogs(PRINCIPAL);
    expect(stale.source).toBe('cache');
    expect(stale.stale).toBe(true);
    expect(stale.items).toHaveLength(1); // old value served

    await new Promise((r) => setTimeout(r, 0));
    expect(engine.catalogCalls).toBe(2);

    const fresh = await service.getCatalogs(PRINCIPAL);
    expect(fresh.source).toBe('cache');
    expect(fresh.stale).toBe(false);
    expect(fresh.items).toHaveLength(2);
  });

  it('keeps serving stale when the background refresh fails', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 1000, clock);
    await service.getCatalogs(PRINCIPAL);

    clock.t += 5000;
    engine.failNext = true;
    const stale = await service.getCatalogs(PRINCIPAL);
    expect(stale.stale).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const retry = await service.getCatalogs(PRINCIPAL);
    expect(retry.items).toHaveLength(1);
  });
});

describe('MetadataService per-principal cache', () => {
  it('keeps separate caches for different principals', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 100000, clock);

    await service.getCatalogs('alice');
    expect(engine.catalogCalls).toBe(1);

    await service.getCatalogs('bob');
    expect(engine.catalogCalls).toBe(2);

    const aliceAgain = await service.getCatalogs('alice');
    expect(aliceAgain.source).toBe('cache');
    expect(engine.catalogCalls).toBe(2);
  });
});

describe('MetadataService.refresh', () => {
  it('forces a re-fetch and resets freshness', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 100000, clock);
    await service.getCatalogs(PRINCIPAL);
    expect(engine.catalogCalls).toBe(1);

    engine.catalogs = [{ name: 'x' }];
    await service.refresh(PRINCIPAL);
    expect(engine.catalogCalls).toBe(2);

    const after = await service.getCatalogs(PRINCIPAL);
    expect(after.source).toBe('cache');
    expect(after.items).toEqual([{ name: 'x' }]);
  });
});

describe('MetadataService cache generation', () => {
  it('does not restore a miss result after datasource invalidation', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 100000, clock);
    const pending = deferred<Catalog[]>();
    let calls = 0;
    engine.listCatalogs = async () => {
      calls += 1;
      if (calls === 1) return pending.promise;
      return [{ name: 'new' }];
    };

    const oldRequest = service.getCatalogs(PRINCIPAL);
    service.invalidateDatasource(engine.datasourceId);
    pending.resolve([{ name: 'old' }]);
    await expect(oldRequest).resolves.toMatchObject({
      source: 'live',
      items: [{ name: 'new' }],
    });

    await expect(service.getCatalogs(PRINCIPAL)).resolves.toMatchObject({
      source: 'cache',
      items: [{ name: 'new' }],
    });
    expect(calls).toBe(2);
  });

  it('retries a miss against the replacement engine instead of returning old metadata', async () => {
    const first = new FakeEngine();
    const second = new FakeEngine();
    second.catalogs = [{ name: 'new-engine' }];
    const pending = deferred<Catalog[]>();
    first.listCatalogs = async () => pending.promise;
    const engines = new Map<string, QueryEngine>([[first.datasourceId, first]]);
    const service = new MetadataService(engines, first.datasourceId, 100000);

    const loading = service.getCatalogs(PRINCIPAL);
    engines.set(first.datasourceId, second);
    pending.resolve([{ name: 'old-engine' }]);

    await expect(loading).resolves.toMatchObject({
      source: 'live',
      items: [{ name: 'new-engine' }],
    });
    expect(second.catalogCalls).toBe(1);
    await expect(service.getCatalogs(PRINCIPAL)).resolves.toMatchObject({
      source: 'cache',
      items: [{ name: 'new-engine' }],
    });
  });

  it('does not restore a stale background result after datasource invalidation', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 1000, clock);
    await service.getCatalogs(PRINCIPAL);

    clock.t = 5000;
    const pending = deferred<Catalog[]>();
    let refreshCalls = 0;
    engine.listCatalogs = async () => {
      refreshCalls += 1;
      if (refreshCalls === 1) return pending.promise;
      return [{ name: 'new' }];
    };
    await expect(service.getCatalogs(PRINCIPAL)).resolves.toMatchObject({ stale: true });
    service.invalidateDatasource(engine.datasourceId);
    pending.resolve([{ name: 'old-refresh' }]);
    await pending.promise;
    await Promise.resolve();

    await expect(service.getCatalogs(PRINCIPAL)).resolves.toMatchObject({
      source: 'live',
      items: [{ name: 'new' }],
    });
    expect(refreshCalls).toBe(2);
  });

  it('retries a forced refresh that crossed an invalidation', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 100000, clock);
    const pending = deferred<Catalog[]>();
    let calls = 0;
    engine.listCatalogs = async () => {
      calls += 1;
      if (calls === 1) return pending.promise;
      return [{ name: 'new' }];
    };

    const refreshing = service.refresh(PRINCIPAL);
    service.invalidateDatasource(engine.datasourceId);
    pending.resolve([{ name: 'old-refresh' }]);
    await refreshing;

    await expect(service.getCatalogs(PRINCIPAL)).resolves.toMatchObject({
      source: 'cache',
      items: [{ name: 'new' }],
    });
    expect(calls).toBe(2);
  });

  it('fails closed when the datasource generation changes during both miss attempts', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 100000, clock);
    const firstPending = deferred<Catalog[]>();
    const secondPending = deferred<Catalog[]>();
    const secondStarted = deferred<void>();
    let calls = 0;
    engine.listCatalogs = async () => {
      calls += 1;
      if (calls === 1) return firstPending.promise;
      secondStarted.resolve(undefined);
      return secondPending.promise;
    };

    const loading = service.getCatalogs(PRINCIPAL);
    service.invalidateDatasource(engine.datasourceId);
    firstPending.resolve([{ name: 'old-first' }]);
    await secondStarted.promise;
    service.invalidateDatasource(engine.datasourceId);
    secondPending.resolve([{ name: 'old-second' }]);

    await expect(loading).rejects.toMatchObject({
      status: 503,
      detail: { code: 'DATASOURCE_RELOADING' },
    });
  });
});

describe('MetadataService cache bounds', () => {
  it('evicts the oldest principal after the per-map entry limit', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 100000, clock);

    for (let index = 0; index <= 500; index += 1) {
      await service.getCatalogs(`principal-${index}`);
    }
    expect(engine.catalogCalls).toBe(501);

    await expect(service.getCatalogs('principal-0')).resolves.toMatchObject({ source: 'live' });
    expect(engine.catalogCalls).toBe(502);
  });

  it('sweeps expired entries other than the requested stale key', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 1000, clock);
    await service.getCatalogs('alice');

    clock.t = 5000;
    await service.getCatalogs('bob');
    const alice = await service.getCatalogs('alice');

    expect(alice.source).toBe('live');
    expect(alice.stale).toBe(false);
    expect(engine.catalogCalls).toBe(3);
  });
});

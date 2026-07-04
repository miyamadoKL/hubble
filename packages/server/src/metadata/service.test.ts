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
import type { QueryEngine } from '../engine/types';

/** A counting fake engine with controllable results. */
class FakeEngine implements QueryEngine {
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
  async listCatalogs(): Promise<Catalog[]> {
    this.catalogCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve(this.catalogs);
  }
  async listSchemas(): Promise<{ name: string }[]> {
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
  async close(): Promise<void> {}
}

function svc(engine: FakeEngine, ttlMs: number, clock: { t: number }): MetadataService {
  const engines = new Map<string, QueryEngine>([[engine.datasourceId, engine]]);
  return new MetadataService(engines, engine.datasourceId, ttlMs, () => clock.t);
}

describe('MetadataService TTL', () => {
  it('serves live on miss, cache on hit within TTL', async () => {
    const engine = new FakeEngine();
    const clock = { t: 1000 };
    const service = svc(engine, 5000, clock);

    const first = await service.getCatalogs();
    expect(first.source).toBe('live');
    expect(first.stale).toBe(false);
    expect(engine.catalogCalls).toBe(1);

    clock.t += 1000; // within TTL
    const second = await service.getCatalogs();
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

    await service.getCatalogs(); // populate
    expect(engine.catalogCalls).toBe(1);

    clock.t += 5000; // now stale
    engine.catalogs = [{ name: 'tpch' }, { name: 'mysql' }];
    const stale = await service.getCatalogs();
    expect(stale.source).toBe('cache');
    expect(stale.stale).toBe(true);
    expect(stale.items).toHaveLength(1); // old value served

    await new Promise((r) => setTimeout(r, 0));
    expect(engine.catalogCalls).toBe(2);

    const fresh = await service.getCatalogs();
    expect(fresh.source).toBe('cache');
    expect(fresh.stale).toBe(false);
    expect(fresh.items).toHaveLength(2);
  });

  it('keeps serving stale when the background refresh fails', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 1000, clock);
    await service.getCatalogs();

    clock.t += 5000;
    engine.failNext = true;
    const stale = await service.getCatalogs();
    expect(stale.stale).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    const retry = await service.getCatalogs();
    expect(retry.items).toHaveLength(1);
  });
});

describe('MetadataService.refresh', () => {
  it('forces a re-fetch and resets freshness', async () => {
    const engine = new FakeEngine();
    const clock = { t: 0 };
    const service = svc(engine, 100000, clock);
    await service.getCatalogs();
    expect(engine.catalogCalls).toBe(1);

    engine.catalogs = [{ name: 'x' }];
    await service.refresh();
    expect(engine.catalogCalls).toBe(2);

    const after = await service.getCatalogs();
    expect(after.source).toBe('cache');
    expect(after.items).toEqual([{ name: 'x' }]);
  });
});

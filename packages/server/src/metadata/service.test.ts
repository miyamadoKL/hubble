import { describe, it, expect } from 'vitest';
import type { Catalog } from '@hue-fable/contracts';
import { MetadataService } from './service';
import type { MetadataSource } from './source';

/** A counting fake source with controllable results. */
class FakeSource {
  catalogCalls = 0;
  schemaCalls = 0;
  catalogs: Catalog[] = [{ name: 'tpch' }];
  failNext = false;

  fetchCatalogs(): Promise<Catalog[]> {
    this.catalogCalls += 1;
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('boom'));
    }
    return Promise.resolve(this.catalogs);
  }
  fetchSchemas(): Promise<{ name: string }[]> {
    this.schemaCalls += 1;
    return Promise.resolve([{ name: 's1' }]);
  }
}

function svc(source: FakeSource, ttlMs: number, clock: { t: number }): MetadataService {
  return new MetadataService(source as unknown as MetadataSource, ttlMs, () => clock.t);
}

describe('MetadataService TTL', () => {
  it('serves live on miss, cache on hit within TTL', async () => {
    const source = new FakeSource();
    const clock = { t: 1000 };
    const service = svc(source, 5000, clock);

    const first = await service.getCatalogs();
    expect(first.source).toBe('live');
    expect(first.stale).toBe(false);
    expect(source.catalogCalls).toBe(1);

    clock.t += 1000; // within TTL
    const second = await service.getCatalogs();
    expect(second.source).toBe('cache');
    expect(second.stale).toBe(false);
    expect(source.catalogCalls).toBe(1); // no re-fetch
  });
});

describe('MetadataService stale-while-revalidate', () => {
  it('serves stale immediately then refreshes in the background', async () => {
    const source = new FakeSource();
    const clock = { t: 0 };
    const service = svc(source, 1000, clock);

    await service.getCatalogs(); // populate
    expect(source.catalogCalls).toBe(1);

    clock.t += 5000; // now stale
    source.catalogs = [{ name: 'tpch' }, { name: 'mysql' }];
    const stale = await service.getCatalogs();
    expect(stale.source).toBe('cache');
    expect(stale.stale).toBe(true);
    expect(stale.items).toHaveLength(1); // old value served

    // Background revalidation has run.
    await new Promise((r) => setTimeout(r, 0));
    expect(source.catalogCalls).toBe(2);

    const fresh = await service.getCatalogs();
    expect(fresh.source).toBe('cache');
    expect(fresh.stale).toBe(false);
    expect(fresh.items).toHaveLength(2);
  });

  it('keeps serving stale when the background refresh fails', async () => {
    const source = new FakeSource();
    const clock = { t: 0 };
    const service = svc(source, 1000, clock);
    await service.getCatalogs();

    clock.t += 5000;
    source.failNext = true;
    const stale = await service.getCatalogs();
    expect(stale.stale).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    // Still serves the cached value; a subsequent call retries.
    const retry = await service.getCatalogs();
    expect(retry.items).toHaveLength(1);
  });
});

describe('MetadataService.refresh', () => {
  it('forces a re-fetch and resets freshness', async () => {
    const source = new FakeSource();
    const clock = { t: 0 };
    const service = svc(source, 100000, clock);
    await service.getCatalogs();
    expect(source.catalogCalls).toBe(1);

    source.catalogs = [{ name: 'x' }];
    await service.refresh();
    expect(source.catalogCalls).toBe(2);

    const after = await service.getCatalogs();
    expect(after.source).toBe('cache');
    expect(after.items).toEqual([{ name: 'x' }]);
  });
});

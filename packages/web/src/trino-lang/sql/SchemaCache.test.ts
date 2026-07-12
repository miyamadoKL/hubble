import { describe, expect, test, vi } from 'vitest';
import { SchemaCache } from './SchemaCache';
import TableReference from '../schema/TableReference';
import type { MetadataSource, MetadataTable } from './MetadataSource';

const ORDERS: MetadataTable = {
  catalog: 'tpch',
  schema: 'tiny',
  name: 'orders',
  columns: [{ name: 'orderkey', type: 'bigint' }],
};

function source(overrides: Partial<MetadataSource> = {}): MetadataSource {
  return {
    listCatalogs: async () => ['tpch'],
    listSchemas: async () => ['tiny'],
    listTables: async () => ['orders'],
    getTable: async () => ORDERS,
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settlePromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('SchemaCache', () => {
  test('synchronous getters are empty until warmers resolve', async () => {
    const cache = new SchemaCache(source());
    expect(cache.getCatalogList()).toEqual([]);
    cache.warmCatalogs();
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.getCatalogList()).toEqual(['tpch']);
  });

  test('warmTables exposes fully-qualified names synchronously after settle', async () => {
    const cache = new SchemaCache(source());
    cache.warmTables('tpch', 'tiny');
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.getTableNameList()).toEqual(['tpch.tiny.orders']);
  });

  test('de-duplicates in-flight warmers (no stampede)', async () => {
    const getTable = vi.fn(async () => ORDERS);
    const cache = new SchemaCache(source({ getTable }));
    const ref = new TableReference('tpch', 'tiny', 'orders');
    cache.warmTable(ref);
    cache.warmTable(ref);
    cache.warmTable(ref);
    await new Promise((r) => setTimeout(r, 5));
    expect(getTable).toHaveBeenCalledTimes(1);
    expect(cache.getTableIfCached(ref)?.getColumns()).toHaveLength(1);
  });

  test('resolveTable awaits and caches', async () => {
    const cache = new SchemaCache(source());
    const ref = new TableReference('tpch', 'tiny', 'orders');
    const table = await cache.resolveTable(ref);
    expect(table?.getName()).toBe('orders');
    // Second call served from cache (getter is now populated).
    expect(cache.getTableIfCached(ref)).toBe(table);
  });

  test('同名オブジェクトのキャッシュをデータソースごとに分離する', async () => {
    let datasourceId = 'primary';
    const getTable = vi.fn(async () => ({
      ...ORDERS,
      columns: [
        datasourceId === 'primary'
          ? { name: 'primary_column', type: 'bigint' }
          : { name: 'secondary_column', type: 'varchar' },
      ],
    }));
    const listCatalogs = vi.fn(async () =>
      datasourceId === 'primary' ? ['primary_catalog'] : ['secondary_catalog'],
    );
    const cache = new SchemaCache(source({ getTable, listCatalogs }), () => datasourceId);
    const ref = new TableReference('tpch', 'tiny', 'orders');

    cache.warmCatalogs();
    const primary = await cache.resolveTable(ref);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cache.getCatalogList()).toEqual(['primary_catalog']);
    expect(primary?.getColumns()[0]?.getName()).toBe('primary_column');

    datasourceId = 'secondary';
    expect(cache.getCatalogList()).toEqual([]);
    expect(cache.getTableIfCached(ref)).toBeUndefined();
    cache.warmCatalogs();
    const secondary = await cache.resolveTable(ref);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cache.getCatalogList()).toEqual(['secondary_catalog']);
    expect(secondary?.getColumns()[0]?.getName()).toBe('secondary_column');

    datasourceId = 'primary';
    expect(cache.getTableIfCached(ref)?.getColumns()[0]?.getName()).toBe('primary_column');
  });

  test('invalidate後は進行中の旧応答をキャッシュへ戻さない', async () => {
    let resolveCatalogs!: (catalogs: string[]) => void;
    const cache = new SchemaCache(
      source({
        listCatalogs: () =>
          new Promise<string[]>((resolve) => {
            resolveCatalogs = resolve;
          }),
      }),
      () => 'primary',
    );

    cache.warmCatalogs();
    cache.invalidate('primary');
    resolveCatalogs(['stale']);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(cache.getCatalogList()).toEqual([]);
  });

  test('invalidate前のrequest完了時に新requestのin-flight所有権を削除しない', async () => {
    const requests: Array<ReturnType<typeof deferred<MetadataTable | undefined>>> = [];
    const getTable = vi.fn(() => {
      const request = deferred<MetadataTable | undefined>();
      requests.push(request);
      return request.promise;
    });
    const cache = new SchemaCache(source({ getTable }), () => 'primary');
    const ref = new TableReference('tpch', 'tiny', 'orders');

    cache.warmTable(ref);
    cache.invalidate('primary');
    cache.warmTable(ref);
    expect(getTable).toHaveBeenCalledTimes(2);

    requests[0]!.resolve({
      ...ORDERS,
      columns: [{ name: 'stale_column', type: 'bigint' }],
    });
    await settlePromises();
    expect(cache.getTableIfCached(ref)).toBeUndefined();

    cache.warmTable(ref);
    expect(getTable).toHaveBeenCalledTimes(2);

    requests[1]!.resolve({
      ...ORDERS,
      columns: [{ name: 'fresh_column', type: 'bigint' }],
    });
    await settlePromises();
    expect(cache.getTableIfCached(ref)?.getColumns()[0]?.getName()).toBe('fresh_column');
    cache.warmTable(ref);
    expect(getTable).toHaveBeenCalledTimes(2);
  });

  test('swallows source errors so completion stays alive', async () => {
    const cache = new SchemaCache(
      source({
        listCatalogs: async () => {
          throw new Error('boom');
        },
      }),
    );
    cache.warmCatalogs();
    await new Promise((r) => setTimeout(r, 5));
    expect(cache.getCatalogList()).toEqual([]);
  });
});

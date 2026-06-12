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

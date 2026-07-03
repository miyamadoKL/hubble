import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  fetchCatalogs,
  fetchSchemas,
  fetchTables,
  fetchTableDetail,
  fetchTableSample,
  refreshMetadata,
  createApiMetadataSource,
  metadataQueryKeys,
} from './metadata';

// Lazy-load data layer for the Data browser tree (design.md §5): each level is
// fetched on demand from `/api/catalogs...`. These tests stub `fetch` to verify
// the right URL is hit, the contract response is parsed, and the MetadataSource
// (used by completion + the tree's cache) dedupes repeat reads.

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const metaEnvelope = <T>(items: T[]) => ({
  items,
  source: 'live' as const,
  stale: false,
  lastUpdatedAt: '2026-06-12T00:00:00.000Z',
});

const DS = 'trino-default';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('metadata fetchers hit datasource-scoped routes', () => {
  test('fetchCatalogs', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(metaEnvelope([{ name: 'tpch' }])));
    const res = await fetchCatalogs(DS);
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/datasources/${DS}/catalogs`,
      expect.anything(),
    );
    expect(res.items).toEqual([{ name: 'tpch' }]);
  });

  test('fetchSchemas encodes the catalog into the path', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(metaEnvelope([{ name: 'sf1' }])));
    await fetchSchemas(DS, 'tpch');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/datasources/${DS}/catalogs/tpch/schemas`,
      expect.anything(),
    );
  });

  test('fetchTables', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(metaEnvelope([{ name: 'orders', type: 'BASE TABLE' }])),
    );
    const res = await fetchTables(DS, 'tpch', 'sf1');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/datasources/${DS}/catalogs/tpch/schemas/sf1/tables`,
      expect.anything(),
    );
    expect(res.items[0]).toMatchObject({ name: 'orders' });
  });

  test('fetchTableDetail parses columns', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        catalog: 'tpch',
        schema: 'sf1',
        name: 'orders',
        columns: [{ name: 'orderkey', type: 'bigint' }],
      }),
    );
    const res = await fetchTableDetail(DS, 'tpch', 'sf1', 'orders');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/datasources/${DS}/catalogs/tpch/schemas/sf1/tables/orders`,
      expect.anything(),
    );
    expect(res.columns).toEqual([{ name: 'orderkey', type: 'bigint' }]);
  });

  test('fetchTableSample', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        columns: [{ name: 'orderkey', type: 'bigint' }],
        rows: [[1], [2]],
        source: 'live',
      }),
    );
    const res = await fetchTableSample(DS, 'tpch', 'sf1', 'orders');
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/datasources/${DS}/catalogs/tpch/schemas/sf1/tables/orders/sample`,
      expect.anything(),
    );
    expect(res.rows).toHaveLength(2);
  });

  test('metadata query keys include datasource id', () => {
    expect(metadataQueryKeys.catalogs('mysql-1')).toEqual(['metadata', 'mysql-1', 'catalogs']);
    expect(metadataQueryKeys.schemas('mysql-1', 'db')).toEqual([
      'metadata',
      'mysql-1',
      'schemas',
      'db',
    ]);
  });

  test('refreshMetadata POSTs an empty scope by default', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
    const res = await refreshMetadata();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/metadata/refresh');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({});
    expect(res.ok).toBe(true);
  });
});

describe('createApiMetadataSource caches through the QueryClient', () => {
  test('repeat listSchemas calls fetch only once (deduped by fetchQuery)', async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const source = createApiMetadataSource(client, () => DS);
    fetchMock.mockResolvedValue(jsonResponse(metaEnvelope([{ name: 'sf1' }, { name: 'sf10' }])));

    const first = await source.listSchemas('tpch');
    const second = await source.listSchemas('tpch');

    expect(first).toEqual(['sf1', 'sf10']);
    expect(second).toEqual(['sf1', 'sf10']);
    // Second read served from the QueryClient cache → no extra fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// Contracts-based metadata fetchers + a MetadataSource implementation for the
// trino-lang language layer (inject a real `/api/datasources/:id/catalogs...`
// client). Caching is delegated to TanStack Query's `queryClient.fetchQuery`,
// so repeated completion/hover passes dedupe network work and respect staleTime.
//
// Trino のメタデータ（カタログ / スキーマ / テーブル / カラム / サンプル行）を
// 取得するための API クライアントファイル。
// 大きく分けて2つの役割を持つ。
//   1. Data ブラウザ（ツリー表示やポップオーバー）が直接 useQuery 経由で呼び出す
//      素朴なフェッチ関数群（fetchCatalogs 等）。
//   2. trino-lang（SQL エディタの補完やホバー機能）が利用する MetadataSource の
//      実装（createApiMetadataSource）。こちらは TanStack Query の
//      queryClient.fetchQuery にキャッシュを委譲することで、補完やホバーの
//      たびに同じメタデータを何度も取得しないようにしている。

import {
  catalogsResponseSchema,
  schemasResponseSchema,
  tablesResponseSchema,
  tableDetailSchema,
  sampleRowsResponseSchema,
  metadataRefreshResponseSchema,
  apiRoutes,
  type CatalogsResponse,
  type SchemasResponse,
  type TablesResponse,
  type TableDetail,
  type SampleRowsResponse,
  type MetadataRefreshResponse,
} from '@hubble/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { MetadataSource, MetadataTable } from '../trino-lang';

/** Stale window matching the server TTL cache. */
export const META_STALE_MS = 5 * 60_000;

// TanStack Query のキャッシュキーを生成するヘルパー群。
// datasourceId を含め、データソース切り替えでキャッシュが分離される。
export const metadataQueryKeys = {
  catalogs: (datasourceId: string) => ['metadata', datasourceId, 'catalogs'] as const,
  schemas: (datasourceId: string, c: string) => ['metadata', datasourceId, 'schemas', c] as const,
  tables: (datasourceId: string, c: string, s: string) =>
    ['metadata', datasourceId, 'tables', c, s] as const,
  table: (datasourceId: string, c: string, s: string, t: string) =>
    ['metadata', datasourceId, 'table', c, s, t] as const,
  sample: (datasourceId: string, c: string, s: string, t: string) =>
    ['metadata', datasourceId, 'sample', c, s, t] as const,
};

/**
 * `GET /api/datasources/:id/catalogs` を呼び出し、カタログ一覧を取得する。
 */
export function fetchCatalogs(datasourceId: string): Promise<CatalogsResponse> {
  return apiFetch(catalogsResponseSchema, apiRoutes.datasourceCatalogs(datasourceId));
}

/**
 * `GET /api/datasources/:id/catalogs/:catalog/schemas` を呼び出す。
 */
export function fetchSchemas(datasourceId: string, catalog: string): Promise<SchemasResponse> {
  return apiFetch(schemasResponseSchema, apiRoutes.datasourceSchemas(datasourceId, catalog));
}

/**
 * `GET /api/datasources/:id/catalogs/:catalog/schemas/:schema/tables` を呼び出す。
 */
export function fetchTables(
  datasourceId: string,
  catalog: string,
  schema: string,
): Promise<TablesResponse> {
  return apiFetch(tablesResponseSchema, apiRoutes.datasourceTables(datasourceId, catalog, schema));
}

/**
 * テーブル詳細を取得する。
 */
export function fetchTableDetail(
  datasourceId: string,
  catalog: string,
  schema: string,
  table: string,
  signal?: AbortSignal,
): Promise<TableDetail> {
  return apiFetch(
    tableDetailSchema,
    apiRoutes.datasourceTable(datasourceId, catalog, schema, table),
    { signal },
  );
}

/**
 * テーブルのサンプル行を取得する。
 */
export function fetchTableSample(
  datasourceId: string,
  catalog: string,
  schema: string,
  table: string,
): Promise<SampleRowsResponse> {
  return apiFetch(
    sampleRowsResponseSchema,
    apiRoutes.datasourceTableSample(datasourceId, catalog, schema, table),
  );
}

/**
 * 指定データソースのメタデータ TTL キャッシュを強制再取得させる。
 */
export function refreshMetadata(
  datasourceId: string,
  scope?: { catalog?: string; schema?: string },
): Promise<MetadataRefreshResponse> {
  return apiFetch(
    metadataRefreshResponseSchema,
    apiRoutes.datasourceMetadataRefresh(datasourceId),
    {
      method: 'POST',
      body: scope ?? {},
    },
  );
}

/**
 * trino-lang 向け MetadataSource。選択中データソース id は getter 経由で読む。
 */
export function createApiMetadataSource(
  queryClient: QueryClient,
  getDatasourceId: () => string,
): MetadataSource {
  return {
    async listCatalogs() {
      const datasourceId = getDatasourceId();
      const res = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.catalogs(datasourceId),
        queryFn: () => fetchCatalogs(datasourceId),
        staleTime: META_STALE_MS,
      });
      return res.items.map((c) => c.name);
    },

    async listSchemas(catalog) {
      const datasourceId = getDatasourceId();
      const res = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.schemas(datasourceId, catalog),
        queryFn: () => fetchSchemas(datasourceId, catalog),
        staleTime: META_STALE_MS,
      });
      return res.items.map((s) => s.name);
    },

    async listTables(catalog, schema) {
      const datasourceId = getDatasourceId();
      const res = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.tables(datasourceId, catalog, schema),
        queryFn: () => fetchTables(datasourceId, catalog, schema),
        staleTime: META_STALE_MS,
      });
      return res.items.map((t) => t.name);
    },

    async getTable(catalog, schema, table): Promise<MetadataTable | undefined> {
      const datasourceId = getDatasourceId();
      const detail = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.table(datasourceId, catalog, schema, table),
        queryFn: () => fetchTableDetail(datasourceId, catalog, schema, table),
        staleTime: META_STALE_MS,
      });
      return {
        catalog: detail.catalog,
        schema: detail.schema,
        name: detail.name,
        comment: detail.comment,
        columns: detail.columns.map((c) => ({ name: c.name, type: c.type, comment: c.comment })),
      };
    },
  };
}

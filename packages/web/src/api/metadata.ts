// Contracts-based metadata fetchers + a MetadataSource implementation for the
// trino-lang language layer (design.md §8: inject a real `/api/catalogs...`
// client). Caching is delegated to TanStack Query's `queryClient.fetchQuery`,
// so repeated completion/hover passes dedupe network work and respect staleTime.

import { z } from 'zod';
import {
  catalogsResponseSchema,
  schemasResponseSchema,
  tablesResponseSchema,
  tableDetailSchema,
  sampleRowsResponseSchema,
  apiRoutes,
  type CatalogsResponse,
  type SchemasResponse,
  type TablesResponse,
  type TableDetail,
  type SampleRowsResponse,
} from '@hubble/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';
import type { MetadataSource, MetadataTable } from '../trino-lang';

/** Stale window matching the server TTL cache (design.md §3). */
export const META_STALE_MS = 5 * 60_000;

export const metadataQueryKeys = {
  catalogs: () => ['metadata', 'catalogs'] as const,
  schemas: (c: string) => ['metadata', 'schemas', c] as const,
  tables: (c: string, s: string) => ['metadata', 'tables', c, s] as const,
  table: (c: string, s: string, t: string) => ['metadata', 'table', c, s, t] as const,
  sample: (c: string, s: string, t: string) => ['metadata', 'sample', c, s, t] as const,
};

// ---- Direct fetchers (used by the Data browser tree / popover via useQuery) --

export function fetchCatalogs(): Promise<CatalogsResponse> {
  return apiFetch(catalogsResponseSchema, apiRoutes.catalogs());
}

export function fetchSchemas(catalog: string): Promise<SchemasResponse> {
  return apiFetch(schemasResponseSchema, apiRoutes.schemas(catalog));
}

export function fetchTables(catalog: string, schema: string): Promise<TablesResponse> {
  return apiFetch(tablesResponseSchema, apiRoutes.tables(catalog, schema));
}

export function fetchTableDetail(
  catalog: string,
  schema: string,
  table: string,
): Promise<TableDetail> {
  return apiFetch(tableDetailSchema, apiRoutes.table(catalog, schema, table));
}

export function fetchTableSample(
  catalog: string,
  schema: string,
  table: string,
): Promise<SampleRowsResponse> {
  return apiFetch(sampleRowsResponseSchema, apiRoutes.tableSample(catalog, schema, table));
}

const refreshResponseSchema = z.object({ ok: z.boolean() });

/** `POST /api/metadata/refresh` — force a re-fetch of the server TTL cache. */
export function refreshMetadata(scope?: { catalog?: string; schema?: string }): Promise<{
  ok: boolean;
}> {
  return apiFetch(refreshResponseSchema, apiRoutes.metadataRefresh(), {
    method: 'POST',
    body: scope ?? {},
  });
}

/** Build a MetadataSource backed by the API and a TanStack QueryClient cache. */
export function createApiMetadataSource(queryClient: QueryClient): MetadataSource {
  return {
    async listCatalogs() {
      const res = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.catalogs(),
        queryFn: () => apiFetch(catalogsResponseSchema, apiRoutes.catalogs()),
        staleTime: META_STALE_MS,
      });
      return res.items.map((c) => c.name);
    },

    async listSchemas(catalog) {
      const res = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.schemas(catalog),
        queryFn: () => apiFetch(schemasResponseSchema, apiRoutes.schemas(catalog)),
        staleTime: META_STALE_MS,
      });
      return res.items.map((s) => s.name);
    },

    async listTables(catalog, schema) {
      const res = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.tables(catalog, schema),
        queryFn: () => apiFetch(tablesResponseSchema, apiRoutes.tables(catalog, schema)),
        staleTime: META_STALE_MS,
      });
      return res.items.map((t) => t.name);
    },

    async getTable(catalog, schema, table): Promise<MetadataTable | undefined> {
      const detail = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.table(catalog, schema, table),
        queryFn: () => apiFetch(tableDetailSchema, apiRoutes.table(catalog, schema, table)),
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

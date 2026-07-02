// Contracts-based metadata fetchers + a MetadataSource implementation for the
// trino-lang language layer (design.md §8: inject a real `/api/catalogs...`
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
//      たびに同じメタデータを何度も取得しないようにしている（design.md §8）。

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
// TanStack Query の staleTime。サーバー側の TTL キャッシュ（design.md §3）に
// 合わせており、この期間内は再フェッチせずキャッシュされた値を使い回す。
export const META_STALE_MS = 5 * 60_000;

// TanStack Query のキャッシュキーを生成するヘルパー群。
// メタデータの種類（catalogs/schemas/tables/table/sample）ごとに、
// 対象を一意に特定できる配列キーを組み立てる。
export const metadataQueryKeys = {
  catalogs: () => ['metadata', 'catalogs'] as const,
  schemas: (c: string) => ['metadata', 'schemas', c] as const,
  tables: (c: string, s: string) => ['metadata', 'tables', c, s] as const,
  table: (c: string, s: string, t: string) => ['metadata', 'table', c, s, t] as const,
  sample: (c: string, s: string, t: string) => ['metadata', 'sample', c, s, t] as const,
};

// ---- Direct fetchers (used by the Data browser tree / popover via useQuery) --
// ここから下は、Data ブラウザのツリーやポップオーバーが useQuery 経由で
// 直接呼び出す素朴なフェッチ関数群。いずれも apiFetch のシンプルなラップ。

/**
 * `GET /api/catalogs` を呼び出し、利用可能な Trino カタログの一覧を取得する。
 * @returns カタログ一覧（CatalogsResponse）。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function fetchCatalogs(): Promise<CatalogsResponse> {
  return apiFetch(catalogsResponseSchema, apiRoutes.catalogs());
}

/**
 * `GET /api/catalogs/:catalog/schemas` を呼び出し、指定カタログ配下の
 * スキーマ一覧を取得する。
 * @param catalog 対象のカタログ名。
 * @returns スキーマ一覧（SchemasResponse）。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function fetchSchemas(catalog: string): Promise<SchemasResponse> {
  return apiFetch(schemasResponseSchema, apiRoutes.schemas(catalog));
}

/**
 * `GET /api/catalogs/:catalog/schemas/:schema/tables` を呼び出し、
 * 指定スキーマ配下のテーブル一覧を取得する。
 * @param catalog 対象のカタログ名。
 * @param schema  対象のスキーマ名。
 * @returns テーブル一覧（TablesResponse）。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function fetchTables(catalog: string, schema: string): Promise<TablesResponse> {
  return apiFetch(tablesResponseSchema, apiRoutes.tables(catalog, schema));
}

/**
 * `GET /api/catalogs/:catalog/schemas/:schema/tables/:table` を呼び出し、
 * 指定テーブルの詳細（カラム一覧やコメント等）を取得する。
 * @param catalog 対象のカタログ名。
 * @param schema  対象のスキーマ名。
 * @param table   対象のテーブル名。
 * @returns テーブル詳細（TableDetail）。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function fetchTableDetail(
  catalog: string,
  schema: string,
  table: string,
): Promise<TableDetail> {
  return apiFetch(tableDetailSchema, apiRoutes.table(catalog, schema, table));
}

/**
 * 指定テーブルのサンプル行を取得する（`GET .../tables/:table/sample` 相当）。
 * Data ブラウザでテーブルをプレビューする際に使用する。
 * @param catalog 対象のカタログ名。
 * @param schema  対象のスキーマ名。
 * @param table   対象のテーブル名。
 * @returns サンプル行のレスポンス（SampleRowsResponse）。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function fetchTableSample(
  catalog: string,
  schema: string,
  table: string,
): Promise<SampleRowsResponse> {
  return apiFetch(sampleRowsResponseSchema, apiRoutes.tableSample(catalog, schema, table));
}

// メタデータ更新（refresh）レスポンス用のスキーマ。`{ ok: boolean }` のみを持つ。
const refreshResponseSchema = z.object({ ok: z.boolean() });

/**
 * `POST /api/metadata/refresh` — force a re-fetch of the server TTL cache.
 * サーバー側の TTL キャッシュを強制的に再取得させる。
 * scope を指定すると特定のカタログ／スキーマのみを対象に更新できる。
 * @param scope 更新対象を絞り込むスコープ（catalog/schema）。省略時は全体を更新。
 * @returns 成否を表す `{ ok: boolean }`。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function refreshMetadata(scope?: { catalog?: string; schema?: string }): Promise<{
  ok: boolean;
}> {
  return apiFetch(refreshResponseSchema, apiRoutes.metadataRefresh(), {
    method: 'POST',
    body: scope ?? {},
  });
}

/**
 * Build a MetadataSource backed by the API and a TanStack QueryClient cache.
 * trino-lang（SQL エディタの補完やホバー機能）から利用される MetadataSource
 * 実装を組み立てる。各メソッドは queryClient.fetchQuery を介してデータを取得し、
 * staleTime（META_STALE_MS）の間はキャッシュされた結果を再利用することで、
 * 補完やホバーのたびに何度もネットワークアクセスが発生しないようにしている。
 *
 * @param queryClient TanStack Query の QueryClient インスタンス（キャッシュの実体）。
 * @returns trino-lang が利用する MetadataSource の実装。
 */
export function createApiMetadataSource(queryClient: QueryClient): MetadataSource {
  return {
    // カタログ名の一覧のみを返す（補完候補として使うため詳細情報は不要）。
    async listCatalogs() {
      const res = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.catalogs(),
        queryFn: () => apiFetch(catalogsResponseSchema, apiRoutes.catalogs()),
        staleTime: META_STALE_MS,
      });
      return res.items.map((c) => c.name);
    },

    // 指定カタログ配下のスキーマ名一覧を返す。
    async listSchemas(catalog) {
      const res = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.schemas(catalog),
        queryFn: () => apiFetch(schemasResponseSchema, apiRoutes.schemas(catalog)),
        staleTime: META_STALE_MS,
      });
      return res.items.map((s) => s.name);
    },

    // 指定スキーマ配下のテーブル名一覧を返す。
    async listTables(catalog, schema) {
      const res = await queryClient.fetchQuery({
        queryKey: metadataQueryKeys.tables(catalog, schema),
        queryFn: () => apiFetch(tablesResponseSchema, apiRoutes.tables(catalog, schema)),
        staleTime: META_STALE_MS,
      });
      return res.items.map((t) => t.name);
    },

    // 指定テーブルの詳細（カラム名、型、コメント）を trino-lang 用の
    // MetadataTable 形式に変換して返す。テーブルが存在しない場合は undefined。
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

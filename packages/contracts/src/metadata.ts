import { z } from 'zod';
import { isoTimestamp } from './common';

/**
 * Metadata model.
 * `system.metadata.catalogs` / `information_schema.tables` / `information_schema.columns`
 * wrapped by the server with a TTL cache + stale-while-revalidate.
 *
 * カタログ、スキーマ、テーブル、カラムといった Trino のメタデータに関する契約を
 * 定義するファイル。server は Trino の `system.metadata.catalogs` /
 * `information_schema.tables` / `information_schema.columns` を TTL 付きキャッシュ
 * (stale-while-revalidate 方式) でラップして web に提供する。
 */

// カタログ（Trino の接続先データソース）1 件分のスキーマ。
export const catalogSchema = z.object({
  name: z.string(),
});

// スキーマ（カタログ配下の名前空間）1 件分のスキーマ。
export const schemaItemSchema = z.object({
  name: z.string(),
});

// テーブル一覧に表示する 1 件分のスキーマ。
export const tableItemSchema = z.object({
  name: z.string(),
  /** 'BASE TABLE' | 'VIEW' | ... as reported by information_schema.tables. */
  // information_schema.tables が報告するテーブル種別（'BASE TABLE' | 'VIEW' など）。
  type: z.string().optional(),
});

// カラム 1 件分のスキーマ。
export const columnSchema = z.object({
  // カラム名。
  name: z.string(),
  // Trino の型名。
  type: z.string(),
  // カラムに付与されたコメント（存在する場合）。
  comment: z.string().optional(),
});

// テーブル詳細（カラム一覧を含む）のスキーマ。
export const tableDetailSchema = z.object({
  catalog: z.string(),
  schema: z.string(),
  name: z.string(),
  // テーブルに付与されたコメント（存在する場合）。
  comment: z.string().optional(),
  // このテーブルの全カラム定義。
  columns: z.array(columnSchema),
});

/** カタログの推論型。 */
export type Catalog = z.infer<typeof catalogSchema>;
/** スキーマ項目の推論型。 */
export type SchemaItem = z.infer<typeof schemaItemSchema>;
/** テーブル項目の推論型。 */
export type TableItem = z.infer<typeof tableItemSchema>;
/** カラムの推論型。 */
export type Column = z.infer<typeof columnSchema>;
/** テーブル詳細の推論型。 */
export type TableDetail = z.infer<typeof tableDetailSchema>;

/**
 * Source of a metadata payload.
 * メタデータ応答がどこから返されたかを示す。'cache'（キャッシュ済み） /
 * 'live'（Trino に問い合わせて取得した最新値）のいずれか。
 */
export const metadataSourceSchema = z.enum(['cache', 'live']);
/** メタデータソースの推論型。 */
export type MetadataSource = z.infer<typeof metadataSourceSchema>;

/**
 * Generic metadata response envelope:
 * `MetadataResponse<T> = { items, source, stale, lastUpdatedAt }`.
 *
 * Use as a schema factory: `metadataResponseSchema(catalogSchema)`.
 *
 * メタデータ系レスポンスの共通エンベロープを生成するスキーマファクトリ関数。
 * catalogs / schemas / tables などエンドポイントごとに中身の item 型は異なるが、
 * 「一覧 + キャッシュ状態」という外側の形は共通なのでジェネリックにしている。
 * 呼び出し例: `metadataResponseSchema(catalogSchema)`。
 */
export function metadataResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    // 一覧本体。
    items: z.array(item),
    // このデータがキャッシュ由来か Trino への即時問い合わせ由来か。
    source: metadataSourceSchema,
    // キャッシュが TTL を超過している（更新中だが古いデータを返している）かどうか。
    stale: z.boolean(),
    /** ISO 8601 timestamp of when the underlying data was last refreshed. */
    // 元データが最後に更新された日時。
    lastUpdatedAt: isoTimestamp,
  });
}

/** `metadataResponseSchema` が生成するレスポンス形状の手書き版ジェネリック型。 */
export type MetadataResponse<T> = {
  items: T[];
  source: MetadataSource;
  stale: boolean;
  lastUpdatedAt: string;
};

// Concrete response schemas for each metadata endpoint.
// 各メタデータエンドポイント用に、ファクトリ関数から具体的なスキーマを生成する。
/** `GET /api/catalogs` のレスポンススキーマ。 */
export const catalogsResponseSchema = metadataResponseSchema(catalogSchema);
/** `GET /api/catalogs/:c/schemas` のレスポンススキーマ。 */
export const schemasResponseSchema = metadataResponseSchema(schemaItemSchema);
/** `GET /api/catalogs/:c/schemas/:s/tables` のレスポンススキーマ。 */
export const tablesResponseSchema = metadataResponseSchema(tableItemSchema);

/** カタログ一覧レスポンスの推論型。 */
export type CatalogsResponse = z.infer<typeof catalogsResponseSchema>;
/** スキーマ一覧レスポンスの推論型。 */
export type SchemasResponse = z.infer<typeof schemasResponseSchema>;
/** テーブル一覧レスポンスの推論型。 */
export type TablesResponse = z.infer<typeof tablesResponseSchema>;

/**
 * Sample-rows response for `GET .../tables/:t/sample` (10 行サンプル).
 * テーブルのサンプル行取得エンドポイントのレスポンス（設計上は 10 行程度を想定）。
 */
export const sampleRowsResponseSchema = z.object({
  // サンプル対象テーブルのカラム定義。
  columns: z.array(columnSchema),
  // サンプル行データ本体。
  rows: z.array(z.array(z.unknown())),
  // サンプルデータの取得元（キャッシュ済みか、都度取得したか）。
  source: metadataSourceSchema,
});

/** サンプル行レスポンスの推論型。 */
export type SampleRowsResponse = z.infer<typeof sampleRowsResponseSchema>;

/**
 * Request body for `POST /api/metadata/refresh`.
 * `POST /api/metadata/refresh` のリクエストボディ。メタデータキャッシュの
 * 強制再取得をトリガーする。catalog / schema を省略すると全体を対象にする。
 */
export const metadataRefreshRequestSchema = z.object({
  // 再取得対象を絞り込むカタログ名（省略時は全カタログ対象）。
  catalog: z.string().optional(),
  // 再取得対象を絞り込むスキーマ名（省略時は catalog 配下全体が対象）。
  schema: z.string().optional(),
});

/** メタデータ再取得リクエストの推論型。 */
export type MetadataRefreshRequest = z.infer<typeof metadataRefreshRequestSchema>;

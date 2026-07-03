import { z } from 'zod';

/**
 * データソース一覧 API の契約（Phase 1）。
 *
 * `GET /api/datasources` が返す公開サマリーのみを定義する。接続先 URL や
 * 認証情報は含めず、kind ごとの機能フラグ (capabilities) だけを公開する。
 */

/** データソース種別。 */
export const datasourceKindSchema = z.enum(['trino', 'mysql', 'postgresql']);
export type DatasourceKind = z.infer<typeof datasourceKindSchema>;

/** kind ごとにサーバーが導出する機能フラグ。 */
export const datasourceCapabilitiesSchema = z.object({
  /** Query Guard によるスキャン量見積もりが利用可能か。 */
  costEstimate: z.boolean(),
  /** カタログ/スキーマ/テーブル等のメタデータブラウジングが利用可能か。 */
  catalogs: z.boolean(),
});
export type DatasourceCapabilities = z.infer<typeof datasourceCapabilitiesSchema>;

/** クライアントに公開するデータソース 1 件分のサマリー。 */
export const datasourceSummarySchema = z.object({
  id: z.string(),
  kind: datasourceKindSchema,
  displayName: z.string(),
  capabilities: datasourceCapabilitiesSchema,
});
export type DatasourceSummary = z.infer<typeof datasourceSummarySchema>;

/** `GET /api/datasources` のレスポンス全体。 */
export const datasourcesResponseSchema = z.object({
  datasources: z.array(datasourceSummarySchema),
});
export type DatasourcesResponse = z.infer<typeof datasourcesResponseSchema>;

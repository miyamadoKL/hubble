import { z } from 'zod';
import { isoTimestamp } from './common';
import { queryStateSchema } from './query';

/**
 * クエリ実行履歴の契約を定義するファイル。ユーザーが明示的に保存しなくても、
 * すべてのクエリ実行が自動的に記録される（Hue の `is_history` 相当の機能）。
 *
 * `QueryHistoryEntry { id, statement(先頭 2000 文字), catalog, schema,
 *   trinoQueryId, state, rowCount, elapsedMs, errorMessage?, notebookId?,
 *   cellId?, submittedAt }`
 */
// 履歴の 1 レコード分のスキーマ。
export const queryHistoryEntrySchema = z.object({
  // 履歴レコードの一意な id。
  id: z.string().min(1),
  // 実行された SQL 文の先頭 2000 文字（全文は保存しない）。
  statement: z.string().max(2000),
  // 実行時のカタログ名。
  catalog: z.string().optional(),
  // 実行時のスキーマ名。
  schema: z.string().optional(),
  // Trino 側のクエリ id（実行が Trino に到達した場合のみ設定される）。
  trinoQueryId: z.string().optional(),
  // 実行の終端状態。
  state: queryStateSchema,
  // 取得された総行数。
  rowCount: z.number().int().nonnegative(),
  // 実行にかかった時間（ミリ秒）。
  elapsedMs: z.number().int().nonnegative(),
  // 失敗時のエラーメッセージ。
  errorMessage: z.string().optional(),
  // このクエリがノートブックのセルから実行された場合、そのノートブック id。
  notebookId: z.string().optional(),
  // このクエリがノートブックのセルから実行された場合、そのセル id。
  cellId: z.string().optional(),
  // クエリが投入された日時。
  submittedAt: isoTimestamp,
  // 実行先データソース id。
  datasourceId: z.string().optional(),
  // 永続化された結果を再実行なしで開けるかどうか。
  resultAvailable: z.boolean().optional(),
  // 永続化結果が失効する日時。
  resultExpiresAt: isoTimestamp.optional(),
});
/** 履歴 1 件分の推論型。 */
export type QueryHistoryEntry = z.infer<typeof queryHistoryEntrySchema>;

/**
 * `GET /api/history` のレスポンス。offset/limit によるページネーションと、
 * state によるフィルタリングをサポートする。
 */
export const historyResponseSchema = z.object({
  // 現在のページに含まれる履歴レコード一覧。
  items: z.array(queryHistoryEntrySchema),
  // このページの開始オフセット。
  offset: z.number().int().nonnegative(),
  // このページの最大件数。
  limit: z.number().int().positive(),
  // フィルタ条件に一致する総件数（ページング UI 用）。
  total: z.number().int().nonnegative(),
});
/** 履歴レスポンス全体の推論型。 */
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

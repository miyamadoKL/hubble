import { z } from 'zod';
import { queryColumnSchema, queryStatsSchema, queryStateSchema } from './query';
import { apiErrorDetailSchema } from './error';

/**
 * クエリ実行の進捗を web にリアルタイム配信する SSE (Server-Sent Events) の契約を
 * 定義するファイル。`type` フィールドを判別子とした discriminated union になっており、
 * SSE の `event:` 名は各スキーマの `type` リテラル値と一致する。
 */

// 実行状態（state）が変化したことを通知するイベント。
export const stateEventSchema = z.object({
  type: z.literal('state'),
  // 新しいクエリ状態（queued / running / finished / failed / canceled）。
  state: queryStateSchema,
  // 実行先データソース id（判明している場合のみ付与）。
  datasourceId: z.string().optional(),
});

// 結果セットの列情報（列名と型）が確定したことを通知するイベント。
export const columnsEventSchema = z.object({
  type: z.literal('columns'),
  // 結果セットの列定義一覧。
  columns: z.array(queryColumnSchema),
});

// 結果行が追加されたことを通知するイベント。ストリーミングでチャンクごとに届く。
export const rowsEventSchema = z.object({
  type: z.literal('rows'),
  // このチャンクの先頭行が結果セット全体で何番目に当たるか（0 始まり）。
  offset: z.number().int().nonnegative(),
  // 追加された行データ本体。
  rows: z.array(z.array(z.unknown())),
});

// Trino の実行統計情報が更新されたことを通知するイベント。
export const statsEventSchema = z.object({
  type: z.literal('stats'),
  // 進捗率、処理行数、メモリ使用量などの統計情報。
  stats: queryStatsSchema,
});

// クエリ実行中にエラーが発生したことを通知するイベント。
export const errorEventSchema = z.object({
  type: z.literal('error'),
  // エラーの詳細（コード、メッセージ、発生位置など）。
  error: apiErrorDetailSchema,
});

// クエリ実行が終端状態に達したことを通知する最終イベント。
export const doneEventSchema = z.object({
  type: z.literal('done'),
  // 終端状態（finished / failed / canceled）。
  state: queryStateSchema,
  // 最終的な総行数。
  rowCount: z.number().int().nonnegative(),
  // maxRows 上限により結果が切り詰められたかどうか。
  truncated: z.boolean(),
  // 全文 CSV ダウンロードのための再実行が許可されるか（QuerySnapshot と同義）。
  csvReexecAllowed: z.boolean().optional(),
});

// 上記すべてのイベント種別をまとめた discriminated union。SSE ストリームで
// 送られてくるイベントはすべてこのいずれかの形状に一致する。
export const queryEventSchema = z.discriminatedUnion('type', [
  stateEventSchema,
  columnsEventSchema,
  rowsEventSchema,
  statsEventSchema,
  errorEventSchema,
  doneEventSchema,
]);

/** state イベントの推論型。 */
export type StateEvent = z.infer<typeof stateEventSchema>;
/** columns イベントの推論型。 */
export type ColumnsEvent = z.infer<typeof columnsEventSchema>;
/** rows イベントの推論型。 */
export type RowsEvent = z.infer<typeof rowsEventSchema>;
/** stats イベントの推論型。 */
export type StatsEvent = z.infer<typeof statsEventSchema>;
/** error イベントの推論型。 */
export type ErrorEvent = z.infer<typeof errorEventSchema>;
/** done イベントの推論型。 */
export type DoneEvent = z.infer<typeof doneEventSchema>;
/** 全イベント種別の union 型。 */
export type QueryEvent = z.infer<typeof queryEventSchema>;

/**
 * SSE イベント名の一覧。各スキーマの `type` 判別子の値と一致する。
 * server 側で `event: <name>` を出力する際や、web 側で `EventSource` の
 * リスナーを登録する際に使う。
 */
export const queryEventNames = ['state', 'columns', 'rows', 'stats', 'error', 'done'] as const;
/** イベント名の推論型（上記配列の要素型）。 */
export type QueryEventName = (typeof queryEventNames)[number];

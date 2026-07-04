import { z } from 'zod';
import { isoTimestamp } from './common';
import { apiErrorDetailSchema } from './error';

/**
 * Query execution model.
 *
 * クエリ実行そのもの（リクエスト、状態、結果ページ）に関する契約を定義するファイル。
 * server はここで定義されたリクエスト形状で SQL 実行を受け付け、非同期に
 * Trino とやり取りしながら状態遷移と結果行を蓄積し、web はポーリングまたは
 * SSE (events.ts) でその進捗を追跡する。
 */

/**
 * Request body for `POST /api/queries`.
 * `POST /api/queries`（クエリ実行開始）のリクエストボディ。
 */
export const createQueryRequestSchema = z.object({
  // 実行する SQL 文。
  statement: z.string().min(1),
  // 実行時のカタログ名。
  catalog: z.string().optional(),
  // 実行時のスキーマ名。
  schema: z.string().optional(),
  /** Trino session properties forwarded as `X-Trino-Session`. */
  // Trino セッションプロパティ。`X-Trino-Session` ヘッダーとして転送される。
  sessionProperties: z.record(z.string(), z.string()).optional(),
  /** Overrides `X-Trino-Source` (default 'hubble'). */
  // `X-Trino-Source` ヘッダーの値を上書きする（既定値は 'hubble'）。
  source: z.string().optional(),
  // このクエリがどのノートブックから実行されたか（履歴記録用）。
  notebookId: z.string().optional(),
  // このクエリがどのセルから実行されたか（履歴記録用）。
  cellId: z.string().optional(),
  /** Cap on rows buffered server-side for this query. */
  // このクエリについて server 側でバッファする行数の上限。省略時は server の既定値。
  maxRows: z.number().int().positive().optional(),
  /** Target datasource id. Omitted = default (first configured datasource). */
  // 実行先データソース id。省略時は既定データソース（設定順先頭）。
  datasourceId: z.string().optional(),
});

/** クエリ実行リクエストの推論型。 */
export type CreateQueryRequest = z.infer<typeof createQueryRequestSchema>;

/**
 * Lifecycle state of a query.
 * クエリのライフサイクル状態。queued（投入待ち）→ running（実行中）→
 * finished/failed/canceled（いずれかの終端状態）と遷移する。
 */
export const queryStateSchema = z.enum(['queued', 'running', 'finished', 'failed', 'canceled']);
/** クエリ状態の推論型。 */
export type QueryState = z.infer<typeof queryStateSchema>;

/**
 * A single result column (name + Trino type).
 * 結果セットの列 1 件分（列名と Trino 型名）のスキーマ。
 */
export const queryColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
});
/** 結果列の推論型。 */
export type QueryColumn = z.infer<typeof queryColumnSchema>;

/**
 * Execution statistics, mirroring Trino's `stats` object.
 * 実行統計情報。Trino の REST API が返す `stats` オブジェクトの形をほぼそのまま反映する。
 */
export const queryStatsSchema = z.object({
  // 進捗率（0〜100）。Trino が算出できない場合は省略される。
  progressPercentage: z.number().min(0).max(100).optional(),
  // Trino 内部での実行ステージ状態（文字列）。
  state: z.string(),
  // キュー待ちの split 数。
  queuedSplits: z.number().int().nonnegative(),
  // 実行中の split 数。
  runningSplits: z.number().int().nonnegative(),
  // 完了済みの split 数。
  completedSplits: z.number().int().nonnegative(),
  // split の総数。
  totalSplits: z.number().int().nonnegative(),
  // これまでに処理された行数。
  processedRows: z.number().int().nonnegative(),
  // これまでに処理されたバイト数。
  processedBytes: z.number().int().nonnegative(),
  // 実時間ベースの経過時間（ミリ秒）。
  wallTimeMillis: z.number().int().nonnegative(),
  // クエリ全体の経過時間（ミリ秒）。
  elapsedTimeMillis: z.number().int().nonnegative(),
  // これまでのピークメモリ使用量（バイト）。
  peakMemoryBytes: z.number().int().nonnegative(),
  // クエリに関与しているワーカーノード数。
  nodes: z.number().int().nonnegative().optional(),
});
/** 実行統計情報の推論型。 */
export type QueryStats = z.infer<typeof queryStatsSchema>;

/**
 * Snapshot returned by `GET /api/queries/:id`.
 * `GET /api/queries/:id` が返す、ある時点でのクエリ実行状態のスナップショット。
 */
export const querySnapshotSchema = z.object({
  /** Server-assigned query id (stable across reconnects). */
  // server が発行したクエリ id。再接続しても変わらない安定した識別子。
  queryId: z.string(),
  /** Trino-side query id, present once the statement is accepted. */
  // Trino 側のクエリ id。Trino に文が受理された後にのみ設定される。
  trinoQueryId: z.string().optional(),
  /** Trino Web UI info URI. */
  // Trino Web UI 上でこのクエリの詳細を確認できる URL。
  infoUri: z.url().optional(),
  // 現在のライフサイクル状態。
  state: queryStateSchema,
  // 現在の実行統計情報（実行開始前は未設定）。
  stats: queryStatsSchema.optional(),
  // 結果列定義（列情報が確定する前は未設定）。
  columns: z.array(queryColumnSchema).optional(),
  /** Total rows produced so far. */
  // これまでに生成された総行数。
  rowCount: z.number().int().nonnegative(),
  /** True when the server capped the result at maxRows. */
  // server が maxRows 上限で結果を打ち切った場合に true になる。
  truncated: z.boolean().default(false),
  // 実行が失敗した場合のエラー詳細。
  error: apiErrorDetailSchema.optional(),
  // クエリが投入された日時。
  submittedAt: isoTimestamp,
  // クエリが終端状態に達した日時（実行中は未設定）。
  finishedAt: isoTimestamp.optional(),
  /** Datasource this query runs against. */
  // このクエリが実行されたデータソース id。
  datasourceId: z.string().optional(),
});
/** クエリスナップショットの推論型。 */
export type QuerySnapshot = z.infer<typeof querySnapshotSchema>;

/**
 * A page of result rows returned by `GET /api/queries/:id/rows`.
 * `GET /api/queries/:id/rows` が返す、結果行の 1 ページ分。
 */
export const queryRowsPageSchema = z.object({
  // このページの先頭行が結果セット全体で何番目に当たるか（0 始まり）。
  offset: z.number().int().nonnegative(),
  // このページに含まれる行データ本体。
  rows: z.array(z.array(z.unknown())),
  /** Total rows currently buffered server-side. */
  // 現時点で server 側にバッファされている総行数。
  totalBuffered: z.number().int().nonnegative(),
  /** True when the query has finished and no more rows will be appended. */
  // クエリが終了しており、以降新たに行が追加されないことを示す。
  complete: z.boolean(),
});
/** 結果行ページの推論型。 */
export type QueryRowsPage = z.infer<typeof queryRowsPageSchema>;

/**
 * Response body for `POST /api/queries` (202).
 * `POST /api/queries` のレスポンスボディ。HTTP 202 (Accepted) とともに返され、
 * クエリが非同期に受理されたことと、その後の追跡に使う queryId を伝える。
 */
export const createQueryResponseSchema = z.object({
  queryId: z.string(),
});
/** クエリ作成レスポンスの推論型。 */
export type CreateQueryResponse = z.infer<typeof createQueryResponseSchema>;

import { z } from 'zod';

/**
 * Query Guard estimate model (Query Guard feature).
 *
 * Before a user runs a (potentially large) statement, the server estimates its
 * scan cost via `EXPLAIN (TYPE IO, FORMAT JSON)` and applies the admin-configured
 * limits to produce a verdict (allow / warn / block).
 *
 * Query Guard（危険なクエリを事前検知して止める機能）の見積もりモデルを定義するファイル。
 * ユーザーが（大規模になりうる）クエリを実行する前に、server が
 * `EXPLAIN (TYPE IO, FORMAT JSON)` を使ってスキャンコストを見積もり、
 * 管理者が設定した上限値と比較して allow / warn / block のいずれかの判定を下す。
 */

/**
 * Request body for `POST /api/queries/estimate`. Mirrors the run-request context.
 * `POST /api/queries/estimate` のリクエストボディ。実際のクエリ実行リクエストと
 * 同じコンテキスト（statement / catalog / schema）を渡す。
 */
export const estimateRequestSchema = z.object({
  // 見積もり対象の SQL 文。
  statement: z.string().min(1),
  // 実行時に使用するカタログ名（省略可）。
  catalog: z.string().optional(),
  // 実行時に使用するスキーマ名（省略可）。
  schema: z.string().optional(),
  /** Target datasource id. Omitted = default (first configured datasource). */
  // 見積もり対象のデータソース id。省略時は既定データソース。
  datasourceId: z.string().optional(),
});
/** 見積もりリクエストの推論型。 */
export type EstimateRequest = z.infer<typeof estimateRequestSchema>;

/**
 * Outcome of the estimation attempt:
 * - `estimated`   : EXPLAIN succeeded and produced an IO plan.
 * - `unsupported` : the statement cannot be EXPLAIN-ed (SHOW/SET/DDL echoes, etc.)
 *                   or failed with a Trino USER_ERROR — no resource risk, allow.
 * - `unavailable` : EXPLAIN timed out or Trino was unreachable — estimate unknown.
 * - `disabled`    : the guard is turned off (mode=off); no estimation performed.
 *
 * 見積もり試行の結果種別。
 * - `estimated`   : EXPLAIN が成功し、IO プランを取得できた。
 * - `unsupported` : 文を EXPLAIN できない（SHOW/SET/DDL のエコーなど）、または
 *                   Trino の USER_ERROR で失敗した場合。リソースリスクがないので許可扱い。
 * - `unavailable` : EXPLAIN がタイムアウトした、または Trino に到達できなかった場合。見積もり不能。
 * - `disabled`    : Query Guard 自体が無効（mode=off）で見積もりを行わなかった場合。
 */
export const estimateStatusSchema = z.enum(['estimated', 'unsupported', 'unavailable', 'disabled']);
/** 見積もりステータスの推論型。 */
export type EstimateStatus = z.infer<typeof estimateStatusSchema>;

/**
 * Final decision and the human-readable reasons behind it.
 * Query Guard の最終判定。'allow'（許可） / 'warn'（警告付き許可） / 'block'（拒否）。
 */
export const guardDecisionSchema = z.enum(['allow', 'warn', 'block']);
/** 判定結果の推論型。 */
export type GuardDecision = z.infer<typeof guardDecisionSchema>;

// 判定結果とその理由をまとめたスキーマ。
export const guardVerdictSchema = z.object({
  decision: guardDecisionSchema,
  /** Human-readable reasons (English), aligned with existing error-message style. */
  // 判定理由（英語の人間可読テキスト）。既存のエラーメッセージ文体に合わせている。
  reasons: z.array(z.string()),
});
/** 判定結果の推論型。 */
export type GuardVerdict = z.infer<typeof guardVerdictSchema>;

/**
 * Per-table scan estimate. `null` when the planner could not estimate it.
 * テーブルごとのスキャン見積もり。プランナが見積もれなかった場合は null になる。
 */
export const estimateTableSchema = z.object({
  // 対象テーブルのカタログ名。
  catalog: z.string(),
  // 対象テーブルのスキーマ名。
  schema: z.string(),
  // 対象テーブル名。
  table: z.string(),
  // 見積もりスキャン行数。
  rows: z.number().nullable(),
  // 見積もりスキャンバイト数。
  bytes: z.number().nullable(),
});
/** テーブル単位見積もりの推論型。 */
export type EstimateTable = z.infer<typeof estimateTableSchema>;

/**
 * Response body for `POST /api/queries/estimate`.
 * `POST /api/queries/estimate` のレスポンスボディ。
 */
export const estimateResultSchema = z.object({
  // 見積もりの試行結果種別（estimated / unsupported / unavailable / disabled）。
  status: estimateStatusSchema,
  /** Sum of input-table `outputSizeInBytes` (null when wholly unknown). */
  // 入力テーブルの outputSizeInBytes 合計値（全く不明な場合は null）。
  scanBytes: z.number().nullable(),
  /** Sum of input-table `outputRowCount` (null when wholly unknown). */
  // 入力テーブルの outputRowCount 合計値（全く不明な場合は null）。
  scanRows: z.number().nullable(),
  /** Top-level estimate of the query's output. */
  // クエリ全体の出力行数見積もり。
  outputRows: z.number().nullable(),
  // クエリ全体の出力バイト数見積もり。
  outputBytes: z.number().nullable(),
  /** scanBytes / BYTES_PER_SECOND, only when BYTES_PER_SECOND is configured. */
  // 見積もり所要時間（秒）。scanBytes / BYTES_PER_SECOND で算出され、
  // BYTES_PER_SECOND が設定されている場合のみ値が入る。
  estimatedSeconds: z.number().nullable(),
  // テーブルごとの見積もり明細。
  tables: z.array(estimateTableSchema),
  // Query Guard の判定結果。
  verdict: guardVerdictSchema,
  /** Wall-clock time the estimation took, in milliseconds. */
  // 見積もり処理自体にかかった実時間（ミリ秒）。
  elapsedMs: z.number().int().nonnegative(),
});
/** 見積もり結果全体の推論型。 */
export type EstimateResult = z.infer<typeof estimateResultSchema>;

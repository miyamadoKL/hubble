import { z } from 'zod';

/**
 * Common API error envelope (design.md §7).
 * Every API failure returns this shape: `{ error: { ... } }`.
 *
 * API のエラーレスポンスの共通契約を定義するファイル。
 * server 側のすべての異常系レスポンスはこの `{ error: { ... } }` 形状に統一され、
 * web 側はこの型だけを見てエラー表示を組み立てる。
 */
export const apiErrorDetailSchema = z.object({
  /** Stable, machine-readable error code (e.g. 'TRINO_ERROR', 'NOT_FOUND'). */
  // 機械可読な安定したエラーコード（例: 'TRINO_ERROR', 'NOT_FOUND'）。web 側の分岐に使われる。
  code: z.string().min(1),
  /** Human-readable message. */
  // 人間可読なエラーメッセージ。
  message: z.string(),
  /** Trino's error name when the failure originates from Trino (e.g. 'SYNTAX_ERROR'). */
  // Trino 由来のエラーの場合の Trino エラー名（例: 'SYNTAX_ERROR'）。Trino 以外が原因の場合は省略。
  trinoErrorName: z.string().optional(),
  /** 1-based source line of a query error, when available. */
  // クエリエラーの発生行（1 始まり）。取得できる場合のみ設定される。
  line: z.number().int().positive().optional(),
  /** 1-based source column of a query error, when available. */
  // クエリエラーの発生列（1 始まり）。取得できる場合のみ設定される。
  column: z.number().int().positive().optional(),
  /**
   * Structured, code-specific payload. Used by `QUERY_BLOCKED` (Query Guard) to
   * carry `{ estimate, limits }` so the web can render why a query was blocked.
   */
  // エラーコードごとに構造が異なる追加ペイロード。
  // 例: Query Guard の `QUERY_BLOCKED` では `{ estimate, limits }` を格納し、
  // web 側がブロック理由（見積もりと上限値）を表示できるようにする。
  details: z.record(z.string(), z.unknown()).optional(),
});

// API エラーレスポンス全体のスキーマ。常に `error` プロパティ 1 つだけを持つ。
export const apiErrorSchema = z.object({
  error: apiErrorDetailSchema,
});

/** エラー詳細部分（`error` プロパティの中身）の推論型。 */
export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;
/** API エラーレスポンス全体の推論型。 */
export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * Error code returned (HTTP 401) when the request could not be authenticated in
 * `proxy` mode — SSO headers were missing or arrived from an untrusted source
 * (design.md §11). The web treats this code as the signal to show the global
 * "authentication required" screen.
 *
 * `proxy` 認証モードでリクエストを認証できなかった場合（SSO ヘッダーが欠落している、
 * または信頼できない送信元から届いた場合）に HTTP 401 とともに返されるエラーコード。
 * web 側はこのコードを見て、アプリ全体を覆う「認証が必要です」画面に切り替える。
 */
export const UNAUTHENTICATED = 'UNAUTHENTICATED';

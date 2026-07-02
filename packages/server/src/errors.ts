/**
 * hubble server 共通のエラー型を定義するファイル。
 *
 * サーバー内のあらゆる場所（ルートハンドラ、サービス層）は成功しないとき
 * `AppError`（またはそのサブクラス）を throw する規約になっており、`app.ts` の
 * `app.onError` がそれを一律に `{ error: { code, message, ... } }` という
 * design.md §7 のエラーエンベロープに変換する。Trino が返すエラー
 * （`TrinoError`）を `AppError` に変換するユーティリティもここに置く。
 */
import type { ApiErrorDetail } from '@hubble/contracts';
import type { TrinoError } from './trino/types';

/**
 * An application error carrying a contract `ApiErrorDetail` and an HTTP status.
 * Thrown throughout the server and rendered uniformly by the error handler in
 * `app.ts` as the `{ error: { ... } }` envelope (design.md §7).
 *
 * 日本語: HTTP ステータスコードと契約上の `ApiErrorDetail`（code/message 等）を
 * セットで運ぶアプリケーションエラー。サーバー内のあらゆる箇所からこのクラス
 * （またはサブクラス）を throw し、`app.ts` のエラーハンドラが一括捕捉して
 * レスポンスに変換する。各 static ファクトリメソッドは、よく使う
 * ステータス/コードの組み合わせを簡潔に生成するためのショートハンド。
 */
export class AppError extends Error {
  readonly status: number;
  readonly detail: ApiErrorDetail;

  constructor(status: number, detail: ApiErrorDetail) {
    super(detail.message);
    this.name = 'AppError';
    this.status = status;
    this.detail = detail;
  }

  /** 日本語: 404 Not Found。存在しないリソース/未知のルートに使う。 */
  static notFound(message: string): AppError {
    return new AppError(404, { code: 'NOT_FOUND', message });
  }

  /** 日本語: 400 Bad Request。バリデーション不備など呼び出し側の入力不正に使う。 */
  static badRequest(message: string, code = 'BAD_REQUEST'): AppError {
    return new AppError(400, { code, message });
  }

  /** 日本語: 409 Conflict。既存リソースとの競合（重複作成など）に使う。 */
  static conflict(message: string): AppError {
    return new AppError(409, { code: 'CONFLICT', message });
  }

  /** 日本語: 500 Internal Server Error。サーバー側の想定外の失敗に使う。 */
  static internal(message: string): AppError {
    return new AppError(500, { code: 'INTERNAL', message });
  }

  /**
   * Query Guard block (Query Guard feature): an estimate exceeded the configured
   * limits in `enforce` mode. Surfaced as HTTP 422 with the `QUERY_BLOCKED` code;
   * `details` carries the `EstimateResult` and the active limits for the UI.
   *
   * 日本語: Query Guard が `enforce` モードで、見積もりスキャン量が設定上限を
   * 超えたためにクエリ実行をブロックしたことを表す。HTTP 422 + `QUERY_BLOCKED`
   * コードで返し、`details` に見積もり結果 (`EstimateResult`) と適用中の上限値を
   * 含めることで、フロントエンドが「なぜブロックされたか」を表示できるようにする。
   */
  static queryBlocked(message: string, details: Record<string, unknown>): AppError {
    return new AppError(422, { code: 'QUERY_BLOCKED', message, details });
  }
}

/** Convert a Trino error payload into a contract `ApiErrorDetail`. */
/**
 * 日本語: Trino の `/v1/statement` レスポンスに含まれるエラーペイロードを、
 * 契約上の `ApiErrorDetail` 形式に変換する。Trino が返す `errorLocation`
 * （エラー箇所の行と列）が正の値で存在する場合のみ `line`/`column` を設定し、
 * エディター側のマーカー表示（design.md §5 の `line N:M` 反映）に使えるようにする。
 */
export function trinoErrorToDetail(error: TrinoError): ApiErrorDetail {
  const detail: ApiErrorDetail = {
    code: 'TRINO_ERROR',
    message: error.message || 'Trino query failed',
  };
  if (error.errorName) detail.trinoErrorName = error.errorName;
  const loc = error.errorLocation;
  if (loc) {
    // 行/列は 1 始まりの正の値のときのみ意味を持つ。0 やマイナスは「情報なし」として扱う。
    if (typeof loc.lineNumber === 'number' && loc.lineNumber > 0) detail.line = loc.lineNumber;
    if (typeof loc.columnNumber === 'number' && loc.columnNumber > 0) {
      detail.column = loc.columnNumber;
    }
  }
  return detail;
}

/**
 * An `AppError` (HTTP 400 — user/query fault) that also retains the raw Trino
 * error so callers that need the `errorType` (e.g. Query Guard, to tell a
 * USER_ERROR apart from an engine fault) can inspect it.
 *
 * 日本語: Trino が返した構造化エラーをラップする `AppError`（HTTP 400 = ユーザー/
 * クエリ側の不備扱い）。レンダリング用の `detail` に加え、生の `TrinoError` を
 * `trino` フィールドとして保持するため、呼び出し元（例えば Query Guard）が
 * `errorType`（USER_ERROR か否か等）を見て挙動を分岐させたいときに参照できる。
 */
export class TrinoQueryError extends AppError {
  readonly trino: TrinoError;
  constructor(error: TrinoError) {
    super(400, trinoErrorToDetail(error));
    this.name = 'TrinoQueryError';
    this.trino = error;
  }
}

/** Build an `AppError` from a Trino error payload (HTTP 400 — user/query fault). */
export function trinoError(error: TrinoError): AppError {
  return new TrinoQueryError(error);
}

/**
 * A transport-level failure talking to Trino (network error, non-2xx that is
 * not a structured Trino error). Surfaced as 502 Bad Gateway.
 *
 * 日本語: Trino との通信そのものが失敗した場合（ネットワークエラー、または
 * 構造化された Trino エラーではない非 2xx レスポンス）に使うエラー。
 * クエリ内容の不備ではなくインフラ側の問題であることを示すため、
 * 400 系ではなく 502 Bad Gateway として返す。
 */
export class TrinoTransportError extends AppError {
  constructor(message: string) {
    super(502, { code: 'TRINO_UNAVAILABLE', message });
    this.name = 'TrinoTransportError';
  }
}

/** Normalize any thrown value into an `ApiErrorDetail` + status. */
/**
 * 日本語: `app.onError` から呼ばれる正規化関数。`AppError`（およびそのサブクラス）
 * であればそのまま status/detail を取り出し、それ以外の任意の thrown 値
 * （想定外の例外、文字列 throw なども含む）は 500 Internal の `ApiErrorDetail` に
 * フォールバックさせることで、レスポンス形式を常に統一エンベロープに揃える。
 */
export function toErrorResponse(err: unknown): { status: number; detail: ApiErrorDetail } {
  if (err instanceof AppError) {
    return { status: err.status, detail: err.detail };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, detail: { code: 'INTERNAL', message } };
}

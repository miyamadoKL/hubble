import { WRITE_NOT_ALLOWED } from '@hubble/contracts';
import { AppError, TrinoQueryError, TrinoTransportError } from '../errors';
import type { RetryPolicy } from '@hubble/contracts';

/**
 * Retry classification + backoff for scheduled runs (Query Scheduling feature).
 *
 * A failure is *deterministic* (never retried) when re-running it would fail the
 * same way: a Trino `USER_ERROR` (syntax / semantic / analysis error) or a Query
 * Guard block. Everything else — transport faults, non-USER_ERROR engine
 * failures — is *transient* and eligible for retry under the schedule's policy.
 *
 * 日本語: このファイルは「失敗の分類」と「バックオフ時間の計算」の 2 つの純粋関数群を
 * 提供する (状態を持たない)。scheduler.ts の attemptWithRetries() がこれらを呼び出し、
 * 分類結果に応じてリトライするかどうかや、どれだけ待つかを決める。deterministic
 * (同じ入力なら何度実行しても同じ結果になる失敗) は即座に確定させ、無駄なリトライで
 * Trino に負荷をかけないようにするのが狙い。
 */
export type FailureClass = 'deterministic' | 'transient';

/** A Query Guard block surfaced through the run path (HTTP 422 / QUERY_BLOCKED). */
// 日本語: EstimateService の見積り結果が block だった場合、scheduler.ts 側は
// AppError.queryBlocked 相当のエラーコードを持つ AppError として扱う。ここではその
// 判定のみを行い、Query Guard によるポリシー上のブロックかどうかを見分ける。
function isQueryBlocked(err: unknown): boolean {
  return err instanceof AppError && err.detail.code === 'QUERY_BLOCKED';
}

/** Classify a thrown error as a deterministic or transient failure. */
// 日本語: 上から順に判定し、最初に該当した分類を返す。
export function classifyFailure(err: unknown): FailureClass {
  // A Trino USER_ERROR is deterministic (bad SQL / analysis error).
  // 日本語: SQL 自体が悪い (構文/意味エラー) ので、何度再試行しても失敗する。
  if (err instanceof TrinoQueryError && err.trino.errorType === 'USER_ERROR') {
    return 'deterministic';
  }
  // A Query Guard block is a policy decision, not a transient fault.
  // 日本語: スキャン量見積りに基づく意図的なブロックであり、障害ではない。
  if (isQueryBlocked(err)) return 'deterministic';
  // RBAC による書き込み拒否は再試行しても同じ結果になる。
  if (err instanceof AppError && err.detail.code === WRITE_NOT_ALLOWED) return 'deterministic';
  // Transport faults and non-USER_ERROR engine failures are transient.
  // 日本語: ネットワーク断や Trino 側の一時的な不調は再試行すれば成功しうる。
  if (err instanceof TrinoTransportError) return 'transient';
  // Any other Trino query error that is NOT a USER_ERROR (engine fault) retries.
  // Unknown errors are treated as transient so a flaky run gets another chance.
  // 日本語: 未知のエラー・USER_ERROR 以外の Trino エラー (エンジン内部の不調等) は
  // 安全側に倒して transient とし、フェイル気味の実行にもう一度チャンスを与える。
  return 'transient';
}

/**
 * Backoff before the Nth retry (1-based: the delay before retry #1 follows
 * attempt #1), in milliseconds:
 *
 *   backoffSeconds * backoffMultiplier^(retryIndex - 1)
 *
 * `retryIndex` is the number of the upcoming retry (1 for the first retry).
 *
 * 日本語: 幾何 (指数) バックオフの計算式。retryIndex=1 (1 回目のリトライ) では
 * backoffSeconds そのもの、retryIndex=2 では backoffSeconds * multiplier、
 * retryIndex=3 では backoffSeconds * multiplier^2 ... と待ち時間が増えていく。
 * 秒単位のポリシー値をミリ秒へ変換し、四捨五入して返す。
 */
export function backoffMs(policy: RetryPolicy, retryIndex: number): number {
  // retryIndex は 1 未満にならないようガードする (0 や負値が渡っても 1 回目扱いにする)。
  const idx = Math.max(retryIndex, 1);
  const seconds = policy.backoffSeconds * Math.pow(policy.backoffMultiplier, idx - 1);
  return Math.round(seconds * 1000);
}

/**
 * Whether another attempt should be made after a transient failure on
 * `attemptsMade` attempts, given the policy. Deterministic failures must be
 * filtered out by the caller before consulting this.
 *
 * 日本語: 単純に「これまでの試行回数が maxAttempts 未満か」を見るだけの判定。
 * deterministic な失敗はこの関数を呼ぶ前に呼び出し側で弾いておく必要がある
 * (retry.ts 自体はどの失敗が deterministic かを覚えていない)。
 */
export function shouldRetry(policy: RetryPolicy, attemptsMade: number): boolean {
  return attemptsMade < policy.maxAttempts;
}

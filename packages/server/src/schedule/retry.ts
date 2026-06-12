import { AppError, TrinoQueryError, TrinoTransportError } from '../errors';
import type { RetryPolicy } from '@hubble/contracts';

/**
 * Retry classification + backoff for scheduled runs (Query Scheduling feature).
 *
 * A failure is *deterministic* (never retried) when re-running it would fail the
 * same way: a Trino `USER_ERROR` (syntax / semantic / analysis error) or a Query
 * Guard block. Everything else — transport faults, non-USER_ERROR engine
 * failures — is *transient* and eligible for retry under the schedule's policy.
 */
export type FailureClass = 'deterministic' | 'transient';

/** A Query Guard block surfaced through the run path (HTTP 422 / QUERY_BLOCKED). */
function isQueryBlocked(err: unknown): boolean {
  return err instanceof AppError && err.detail.code === 'QUERY_BLOCKED';
}

/** Classify a thrown error as a deterministic or transient failure. */
export function classifyFailure(err: unknown): FailureClass {
  // A Trino USER_ERROR is deterministic (bad SQL / analysis error).
  if (err instanceof TrinoQueryError && err.trino.errorType === 'USER_ERROR') {
    return 'deterministic';
  }
  // A Query Guard block is a policy decision, not a transient fault.
  if (isQueryBlocked(err)) return 'deterministic';
  // Transport faults and non-USER_ERROR engine failures are transient.
  if (err instanceof TrinoTransportError) return 'transient';
  // Any other Trino query error that is NOT a USER_ERROR (engine fault) retries.
  // Unknown errors are treated as transient so a flaky run gets another chance.
  return 'transient';
}

/**
 * Backoff before the Nth retry (1-based: the delay before retry #1 follows
 * attempt #1), in milliseconds:
 *
 *   backoffSeconds * backoffMultiplier^(retryIndex - 1)
 *
 * `retryIndex` is the number of the upcoming retry (1 for the first retry).
 */
export function backoffMs(policy: RetryPolicy, retryIndex: number): number {
  const idx = Math.max(retryIndex, 1);
  const seconds = policy.backoffSeconds * Math.pow(policy.backoffMultiplier, idx - 1);
  return Math.round(seconds * 1000);
}

/**
 * Whether another attempt should be made after a transient failure on
 * `attemptsMade` attempts, given the policy. Deterministic failures must be
 * filtered out by the caller before consulting this.
 */
export function shouldRetry(policy: RetryPolicy, attemptsMade: number): boolean {
  return attemptsMade < policy.maxAttempts;
}

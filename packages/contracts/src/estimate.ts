import { z } from 'zod';

/**
 * Query Guard estimate model (Query Guard feature).
 *
 * Before a user runs a (potentially large) statement, the server estimates its
 * scan cost via `EXPLAIN (TYPE IO, FORMAT JSON)` and applies the admin-configured
 * limits to produce a verdict (allow / warn / block).
 */

/** Request body for `POST /api/queries/estimate`. Mirrors the run-request context. */
export const estimateRequestSchema = z.object({
  statement: z.string().min(1),
  catalog: z.string().optional(),
  schema: z.string().optional(),
});
export type EstimateRequest = z.infer<typeof estimateRequestSchema>;

/**
 * Outcome of the estimation attempt:
 * - `estimated`   : EXPLAIN succeeded and produced an IO plan.
 * - `unsupported` : the statement cannot be EXPLAIN-ed (SHOW/SET/DDL echoes, etc.)
 *                   or failed with a Trino USER_ERROR — no resource risk, allow.
 * - `unavailable` : EXPLAIN timed out or Trino was unreachable — estimate unknown.
 * - `disabled`    : the guard is turned off (mode=off); no estimation performed.
 */
export const estimateStatusSchema = z.enum(['estimated', 'unsupported', 'unavailable', 'disabled']);
export type EstimateStatus = z.infer<typeof estimateStatusSchema>;

/** Final decision and the human-readable reasons behind it. */
export const guardDecisionSchema = z.enum(['allow', 'warn', 'block']);
export type GuardDecision = z.infer<typeof guardDecisionSchema>;

export const guardVerdictSchema = z.object({
  decision: guardDecisionSchema,
  /** Human-readable reasons (English), aligned with existing error-message style. */
  reasons: z.array(z.string()),
});
export type GuardVerdict = z.infer<typeof guardVerdictSchema>;

/** Per-table scan estimate. `null` when the planner could not estimate it. */
export const estimateTableSchema = z.object({
  catalog: z.string(),
  schema: z.string(),
  table: z.string(),
  rows: z.number().nullable(),
  bytes: z.number().nullable(),
});
export type EstimateTable = z.infer<typeof estimateTableSchema>;

/** Response body for `POST /api/queries/estimate`. */
export const estimateResultSchema = z.object({
  status: estimateStatusSchema,
  /** Sum of input-table `outputSizeInBytes` (null when wholly unknown). */
  scanBytes: z.number().nullable(),
  /** Sum of input-table `outputRowCount` (null when wholly unknown). */
  scanRows: z.number().nullable(),
  /** Top-level estimate of the query's output. */
  outputRows: z.number().nullable(),
  outputBytes: z.number().nullable(),
  /** scanBytes / BYTES_PER_SECOND, only when BYTES_PER_SECOND is configured. */
  estimatedSeconds: z.number().nullable(),
  tables: z.array(estimateTableSchema),
  verdict: guardVerdictSchema,
  /** Wall-clock time the estimation took, in milliseconds. */
  elapsedMs: z.number().int().nonnegative(),
});
export type EstimateResult = z.infer<typeof estimateResultSchema>;

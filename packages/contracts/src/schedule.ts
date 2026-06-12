import { z } from 'zod';
import { isoTimestamp } from './common';

/**
 * Query scheduling models (Query Scheduling feature).
 *
 * A `Schedule` runs a saved statement on a cron schedule. Each firing produces a
 * `ScheduleRun` row recording the outcome of that run (one row per run, even if
 * the run retried internally — see `RetryPolicy`). The statement is validated
 * with Trino's `EXPLAIN (TYPE VALIDATE)` at create/update time and again
 * immediately before every execution, so syntactically invalid queries never
 * reach the cluster as a real run.
 */

/** Terminal status of a single scheduled run. */
export const scheduleRunStatusSchema = z.enum([
  'running',
  'success',
  'failed',
  'aborted',
  'blocked',
]);
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>;

/**
 * A 5-field standard cron expression (`minute hour day-of-month month
 * day-of-week`). Validated structurally here; semantic parsing (and the actual
 * next-run computation) happens server-side with `cron-parser`. The fields may
 * use `*`, ranges (`1-5`), lists (`1,15`), step values, and the usual
 * combinations; this regex rejects obvious garbage early so the contract stays
 * the single source of truth for the shape.
 */
const CRON_FIELD = String.raw`[0-9A-Za-z*/,\-?]+`;
export const cronExpression = z
  .string()
  .trim()
  .regex(
    new RegExp(`^${CRON_FIELD}(?:\\s+${CRON_FIELD}){4}$`),
    'Must be a 5-field cron expression (minute hour day-of-month month day-of-week)',
  );

/**
 * Retry policy for a schedule (Query Scheduling feature). Applied only to
 * non-deterministic failures (transport faults, non-USER_ERROR engine
 * failures). Deterministic failures — a `USER_ERROR` from `EXPLAIN VALIDATE` or
 * the run itself, or a Query Guard block — are never retried.
 *
 * Backoff before the Nth retry is `backoffSeconds * backoffMultiplier^(n-1)`.
 */
export const retryPolicySchema = z.object({
  /** Total attempts including the first (1 disables retries). */
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /** Base delay before the first retry, in seconds. */
  backoffSeconds: z.number().int().min(1).max(3600).default(60),
  /** Geometric backoff multiplier applied per subsequent retry. */
  backoffMultiplier: z.number().int().min(1).max(10).default(2),
});
export type RetryPolicy = z.infer<typeof retryPolicySchema>;

/** Default retry policy (used when a request omits it). */
export const defaultRetryPolicy: RetryPolicy = retryPolicySchema.parse({});

/** Compact summary of the most recent run, embedded in a `Schedule` response. */
export const scheduleRunSummarySchema = z.object({
  id: z.string().min(1),
  status: scheduleRunStatusSchema,
  attempt: z.number().int().nonnegative(),
  trinoQueryId: z.string().nullable(),
  errorType: z.string().nullable(),
  errorMessage: z.string().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  elapsedMs: z.number().int().nonnegative().nullable(),
  scheduledFor: isoTimestamp,
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp.nullable(),
});
export type ScheduleRunSummary = z.infer<typeof scheduleRunSummarySchema>;

/** A full run record (`GET /api/schedules/:id/runs`). */
export const scheduleRunSchema = scheduleRunSummarySchema.extend({
  scheduleId: z.string().min(1),
});
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;

/**
 * A scheduled query (Query Scheduling feature).
 * `nextRunAt` is computed from the cron expression at response time (null when
 * disabled or uncomputable); `lastRun` summarizes the most recent run.
 */
export const scheduleSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  statement: z.string(),
  catalog: z.string().nullable(),
  schema: z.string().nullable(),
  cron: cronExpression,
  enabled: z.boolean(),
  retry: retryPolicySchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  /** Next computed fire time (ISO), or null when disabled / uncomputable. */
  nextRunAt: isoTimestamp.nullable(),
  /** Most recent run, or null if the schedule has never run. */
  lastRun: scheduleRunSummarySchema.nullable(),
});
export type Schedule = z.infer<typeof scheduleSchema>;

/** Request body for `POST /api/schedules`. */
export const createScheduleRequestSchema = z.object({
  name: z.string().min(1),
  statement: z.string().min(1),
  catalog: z.string().optional(),
  schema: z.string().optional(),
  cron: cronExpression,
  enabled: z.boolean().optional(),
  retry: retryPolicySchema.optional(),
});
export type CreateScheduleRequest = z.infer<typeof createScheduleRequestSchema>;

/**
 * Request body for `PATCH /api/schedules/:id`. Every field is optional; only the
 * provided fields are updated. Changing `statement`, `catalog`, `schema`, or
 * `cron` re-validates the statement with `EXPLAIN (TYPE VALIDATE)`.
 */
export const updateScheduleRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    statement: z.string().min(1).optional(),
    catalog: z.string().nullable().optional(),
    schema: z.string().nullable().optional(),
    cron: cronExpression.optional(),
    enabled: z.boolean().optional(),
    retry: retryPolicySchema.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });
export type UpdateScheduleRequest = z.infer<typeof updateScheduleRequestSchema>;

/** Response for `GET /api/schedules/:id/runs?limit=`. */
export const scheduleRunsResponseSchema = z.object({
  items: z.array(scheduleRunSchema),
});
export type ScheduleRunsResponse = z.infer<typeof scheduleRunsResponseSchema>;

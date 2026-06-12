import { z } from 'zod';
import { isoTimestamp } from './common';
import { apiErrorDetailSchema } from './error';

/**
 * Query execution model (design.md §4, §7).
 */

/** Request body for `POST /api/queries`. */
export const createQueryRequestSchema = z.object({
  statement: z.string().min(1),
  catalog: z.string().optional(),
  schema: z.string().optional(),
  /** Trino session properties forwarded as `X-Trino-Session`. */
  sessionProperties: z.record(z.string(), z.string()).optional(),
  /** Overrides `X-Trino-Source` (default 'hubble'). */
  source: z.string().optional(),
  notebookId: z.string().optional(),
  cellId: z.string().optional(),
  /** Cap on rows buffered server-side for this query. */
  maxRows: z.number().int().positive().optional(),
});

export type CreateQueryRequest = z.infer<typeof createQueryRequestSchema>;

/** Lifecycle state of a query. */
export const queryStateSchema = z.enum(['queued', 'running', 'finished', 'failed', 'canceled']);
export type QueryState = z.infer<typeof queryStateSchema>;

/** A single result column (name + Trino type). */
export const queryColumnSchema = z.object({
  name: z.string(),
  type: z.string(),
});
export type QueryColumn = z.infer<typeof queryColumnSchema>;

/** Execution statistics, mirroring Trino's `stats` object (design.md §7). */
export const queryStatsSchema = z.object({
  progressPercentage: z.number().min(0).max(100).optional(),
  state: z.string(),
  queuedSplits: z.number().int().nonnegative(),
  runningSplits: z.number().int().nonnegative(),
  completedSplits: z.number().int().nonnegative(),
  totalSplits: z.number().int().nonnegative(),
  processedRows: z.number().int().nonnegative(),
  processedBytes: z.number().int().nonnegative(),
  wallTimeMillis: z.number().int().nonnegative(),
  elapsedTimeMillis: z.number().int().nonnegative(),
  peakMemoryBytes: z.number().int().nonnegative(),
  nodes: z.number().int().nonnegative().optional(),
});
export type QueryStats = z.infer<typeof queryStatsSchema>;

/** Snapshot returned by `GET /api/queries/:id`. */
export const querySnapshotSchema = z.object({
  /** Server-assigned query id (stable across reconnects). */
  queryId: z.string(),
  /** Trino-side query id, present once the statement is accepted. */
  trinoQueryId: z.string().optional(),
  /** Trino Web UI info URI. */
  infoUri: z.url().optional(),
  state: queryStateSchema,
  stats: queryStatsSchema.optional(),
  columns: z.array(queryColumnSchema).optional(),
  /** Total rows produced so far. */
  rowCount: z.number().int().nonnegative(),
  /** True when the server capped the result at maxRows. */
  truncated: z.boolean().default(false),
  error: apiErrorDetailSchema.optional(),
  submittedAt: isoTimestamp,
  finishedAt: isoTimestamp.optional(),
});
export type QuerySnapshot = z.infer<typeof querySnapshotSchema>;

/** A page of result rows returned by `GET /api/queries/:id/rows`. */
export const queryRowsPageSchema = z.object({
  offset: z.number().int().nonnegative(),
  rows: z.array(z.array(z.unknown())),
  /** Total rows currently buffered server-side. */
  totalBuffered: z.number().int().nonnegative(),
  /** True when the query has finished and no more rows will be appended. */
  complete: z.boolean(),
});
export type QueryRowsPage = z.infer<typeof queryRowsPageSchema>;

/** Response body for `POST /api/queries` (202). */
export const createQueryResponseSchema = z.object({
  queryId: z.string(),
});
export type CreateQueryResponse = z.infer<typeof createQueryResponseSchema>;

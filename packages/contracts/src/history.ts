import { z } from 'zod';
import { isoTimestamp } from './common';
import { queryStateSchema } from './query';

/**
 * Query history model (design.md §4, §7). Auto-recorded per execution
 * (Hue's `is_history` equivalent).
 *
 * `QueryHistoryEntry { id, statement(first 2000 chars), catalog, schema,
 *   trinoQueryId, state, rowCount, elapsedMs, errorMessage?, notebookId?,
 *   cellId?, submittedAt }`
 */
export const queryHistoryEntrySchema = z.object({
  id: z.string().min(1),
  /** First 2000 chars of the executed statement. */
  statement: z.string().max(2000),
  catalog: z.string().optional(),
  schema: z.string().optional(),
  trinoQueryId: z.string().optional(),
  state: queryStateSchema,
  rowCount: z.number().int().nonnegative(),
  elapsedMs: z.number().int().nonnegative(),
  errorMessage: z.string().optional(),
  notebookId: z.string().optional(),
  cellId: z.string().optional(),
  submittedAt: isoTimestamp,
});
export type QueryHistoryEntry = z.infer<typeof queryHistoryEntrySchema>;

/** Response for `GET /api/history?offset&limit&state=`. */
export const historyResponseSchema = z.object({
  items: z.array(queryHistoryEntrySchema),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
});
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

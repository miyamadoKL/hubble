import { z } from 'zod';
import { queryColumnSchema, queryStatsSchema, queryStateSchema } from './query';
import { apiErrorDetailSchema } from './error';

/**
 * Server-Sent Events for `GET /api/queries/:id/events` (design.md §7).
 * Discriminated union keyed on `type`. The SSE `event:` name mirrors `type`.
 */

export const stateEventSchema = z.object({
  type: z.literal('state'),
  state: queryStateSchema,
});

export const columnsEventSchema = z.object({
  type: z.literal('columns'),
  columns: z.array(queryColumnSchema),
});

/** A chunk of appended rows. `offset` is the index of the first row in the chunk. */
export const rowsEventSchema = z.object({
  type: z.literal('rows'),
  offset: z.number().int().nonnegative(),
  rows: z.array(z.array(z.unknown())),
});

export const statsEventSchema = z.object({
  type: z.literal('stats'),
  stats: queryStatsSchema,
});

export const errorEventSchema = z.object({
  type: z.literal('error'),
  error: apiErrorDetailSchema,
});

export const doneEventSchema = z.object({
  type: z.literal('done'),
  state: queryStateSchema,
  rowCount: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export const queryEventSchema = z.discriminatedUnion('type', [
  stateEventSchema,
  columnsEventSchema,
  rowsEventSchema,
  statsEventSchema,
  errorEventSchema,
  doneEventSchema,
]);

export type StateEvent = z.infer<typeof stateEventSchema>;
export type ColumnsEvent = z.infer<typeof columnsEventSchema>;
export type RowsEvent = z.infer<typeof rowsEventSchema>;
export type StatsEvent = z.infer<typeof statsEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type DoneEvent = z.infer<typeof doneEventSchema>;
export type QueryEvent = z.infer<typeof queryEventSchema>;

/** The set of SSE event names, matching the `type` discriminant. */
export const queryEventNames = ['state', 'columns', 'rows', 'stats', 'error', 'done'] as const;
export type QueryEventName = (typeof queryEventNames)[number];

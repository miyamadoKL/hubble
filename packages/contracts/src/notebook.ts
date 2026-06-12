import { z } from 'zod';
import { isoTimestamp } from './common';

/**
 * Notebook model (design.md §4). Hue's `Notebook { snippets[] }` simplified to a
 * single `cells` array (tabs/cells double-holding removed per prior lesson).
 */

/** Variable input widget type. */
export const variableTypeSchema = z.enum([
  'text',
  'number',
  'date',
  'datetime-local',
  'checkbox',
  'select',
]);
export type VariableType = z.infer<typeof variableTypeSchema>;

/** An option for a 'select' variable. */
export const variableOptionSchema = z.object({
  label: z.string(),
  value: z.string(),
});
export type VariableOption = z.infer<typeof variableOptionSchema>;

export const variableMetaSchema = z.object({
  type: variableTypeSchema,
  options: z.array(variableOptionSchema).optional(),
  placeholder: z.string().optional(),
});
export type VariableMeta = z.infer<typeof variableMetaSchema>;

export const variableSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
  meta: variableMetaSchema,
});
export type Variable = z.infer<typeof variableSchema>;

export const cellKindSchema = z.enum(['sql', 'markdown']);
export type CellKind = z.infer<typeof cellKindSchema>;

/**
 * Summary of a cell's last execution, persisted with the notebook
 * (full result rows are NOT persisted — design.md §4).
 */
export const cellResultMetaSchema = z.object({
  trinoQueryId: z.string().optional(),
  state: z.string().optional(),
  rowCount: z.number().int().nonnegative().optional(),
  elapsedMs: z.number().int().nonnegative().optional(),
  errorMessage: z.string().optional(),
  executedAt: isoTimestamp.optional(),
});
export type CellResultMeta = z.infer<typeof cellResultMetaSchema>;

export const cellSchema = z.object({
  id: z.string().min(1),
  kind: cellKindSchema,
  source: z.string(),
  name: z.string().optional(),
  collapsed: z.boolean().optional(),
  resultMeta: cellResultMetaSchema.optional(),
});
export type Cell = z.infer<typeof cellSchema>;

export const notebookContextSchema = z.object({
  catalog: z.string().optional(),
  schema: z.string().optional(),
});
export type NotebookContext = z.infer<typeof notebookContextSchema>;

export const notebookSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  cells: z.array(cellSchema),
  variables: z.array(variableSchema),
  context: notebookContextSchema,
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type Notebook = z.infer<typeof notebookSchema>;

/** Notebook list item (lightweight, no cells) for `GET /api/notebooks`. */
export const notebookListItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  updatedAt: isoTimestamp,
  createdAt: isoTimestamp,
});
export type NotebookListItem = z.infer<typeof notebookListItemSchema>;

/** Request body for `POST /api/notebooks`. */
export const createNotebookRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  cells: z.array(cellSchema).optional(),
  variables: z.array(variableSchema).optional(),
  context: notebookContextSchema.optional(),
});
export type CreateNotebookRequest = z.infer<typeof createNotebookRequestSchema>;

/** Request body for `PUT /api/notebooks/:id` (full replace of mutable fields). */
export const updateNotebookRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  cells: z.array(cellSchema),
  variables: z.array(variableSchema),
  context: notebookContextSchema,
});
export type UpdateNotebookRequest = z.infer<typeof updateNotebookRequestSchema>;

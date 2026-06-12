import { z } from 'zod';
import { isoTimestamp } from './common';

/**
 * SavedQuery model (design.md §4).
 * `SavedQuery { id, name, description, statement, catalog?, schema?, isFavorite, createdAt, updatedAt }`
 */
export const savedQuerySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  statement: z.string(),
  catalog: z.string().optional(),
  schema: z.string().optional(),
  isFavorite: z.boolean(),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
});
export type SavedQuery = z.infer<typeof savedQuerySchema>;

/** Request body for `POST /api/saved-queries`. */
export const createSavedQueryRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  statement: z.string().min(1),
  catalog: z.string().optional(),
  schema: z.string().optional(),
  isFavorite: z.boolean().optional(),
});
export type CreateSavedQueryRequest = z.infer<typeof createSavedQueryRequestSchema>;

/** Request body for `PUT /api/saved-queries/:id`. */
export const updateSavedQueryRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  statement: z.string().min(1),
  catalog: z.string().optional(),
  schema: z.string().optional(),
  isFavorite: z.boolean(),
});
export type UpdateSavedQueryRequest = z.infer<typeof updateSavedQueryRequestSchema>;

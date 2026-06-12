// Saved-query CRUD fetchers (design.md §7). Thin wrappers over `apiFetch`, each
// validating against the contract schema. `GET /api/saved-queries` returns a
// bare array (server: storeRoutes); the search term is debounced at the call
// site (the panel), not here.

import { z } from 'zod';
import {
  savedQuerySchema,
  apiRoutes,
  type CreateSavedQueryRequest,
  type SavedQuery,
  type UpdateSavedQueryRequest,
} from '@hubble/contracts';
import { apiFetch } from './client';

const savedQueryListSchema = z.array(savedQuerySchema);
const okSchema = z.object({ ok: z.boolean() });

/** List saved queries, optionally filtered by `query` (name/statement LIKE). */
export function listSavedQueries(query?: string): Promise<SavedQuery[]> {
  return apiFetch(savedQueryListSchema, apiRoutes.savedQueries(), {
    query: query ? { query } : undefined,
  });
}

/** Create a saved query (`POST`, 201) and return the persisted record. */
export function createSavedQuery(body: CreateSavedQueryRequest): Promise<SavedQuery> {
  return apiFetch(savedQuerySchema, apiRoutes.savedQueries(), { method: 'POST', body });
}

/** Replace a saved query's mutable fields (`PUT`). */
export function updateSavedQuery(id: string, body: UpdateSavedQueryRequest): Promise<SavedQuery> {
  return apiFetch(savedQuerySchema, apiRoutes.savedQuery(id), { method: 'PUT', body });
}

/** Delete a saved query. Resolves true on success. */
export async function deleteSavedQuery(id: string): Promise<boolean> {
  const res = await apiFetch(okSchema, apiRoutes.savedQuery(id), { method: 'DELETE' });
  return res.ok;
}

// Notebook CRUD fetchers (design.md §7). Thin wrappers over `apiFetch`, each
// validating against the contract schema. The notebookStore drives these for
// list / open / create / save / delete; the persistence policy (debounce,
// POST-vs-PUT) lives in the store, not here.

import { z } from 'zod';
import {
  notebookSchema,
  notebookListItemSchema,
  apiRoutes,
  type CreateNotebookRequest,
  type Notebook,
  type NotebookListItem,
  type UpdateNotebookRequest,
} from '@hubble/contracts';
import { apiFetch } from './client';

/** `GET /api/notebooks` returns a bare array of list items (server: storeRoutes). */
const notebookListSchema = z.array(notebookListItemSchema);
const okSchema = z.object({ ok: z.boolean() });

/** List notebooks, optionally filtered by `query` (name/description LIKE). */
export function listNotebooks(query?: string): Promise<NotebookListItem[]> {
  return apiFetch(notebookListSchema, apiRoutes.notebooks(), {
    query: query ? { query } : undefined,
  });
}

/** Fetch a full notebook (cells/variables/context). */
export function getNotebook(id: string): Promise<Notebook> {
  return apiFetch(notebookSchema, apiRoutes.notebook(id));
}

/** Create a notebook (`POST`, 201) and return the persisted record. */
export function createNotebook(body: CreateNotebookRequest): Promise<Notebook> {
  return apiFetch(notebookSchema, apiRoutes.notebooks(), { method: 'POST', body });
}

/** Replace a notebook's mutable fields (`PUT`). */
export function updateNotebook(id: string, body: UpdateNotebookRequest): Promise<Notebook> {
  return apiFetch(notebookSchema, apiRoutes.notebook(id), { method: 'PUT', body });
}

/** Delete a notebook. Resolves true on success. */
export async function deleteNotebook(id: string): Promise<boolean> {
  const res = await apiFetch(okSchema, apiRoutes.notebook(id), { method: 'DELETE' });
  return res.ok;
}

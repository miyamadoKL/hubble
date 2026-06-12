// Typed API helpers for the query lifecycle (design.md §7). Thin wrappers over
// the shared `apiFetch` so the execution store stays focused on state rather
// than fetch/zod plumbing.

import {
  createQueryRequestSchema,
  createQueryResponseSchema,
  querySnapshotSchema,
  queryRowsPageSchema,
  type CreateQueryRequest,
  type CreateQueryResponse,
  type QuerySnapshot,
  type QueryRowsPage,
} from '@hubble/contracts';
import { apiFetch, apiRoutes } from '../api/client';

/** `POST /api/queries` → 202 `{ queryId }`. */
export function createQuery(request: CreateQueryRequest): Promise<CreateQueryResponse> {
  // Validate the request shape up front so a bad call fails loudly in dev.
  const body = createQueryRequestSchema.parse(request);
  return apiFetch(createQueryResponseSchema, apiRoutes.queries(), { method: 'POST', body });
}

/** `GET /api/queries/:id` snapshot (for reconnect/restore). */
export function fetchQuerySnapshot(queryId: string): Promise<QuerySnapshot> {
  return apiFetch(querySnapshotSchema, apiRoutes.query(queryId));
}

/** `GET /api/queries/:id/rows?offset&limit` page (for reconnect/restore). */
export function fetchQueryRows(
  queryId: string,
  offset: number,
  limit: number,
): Promise<QueryRowsPage> {
  return apiFetch(queryRowsPageSchema, apiRoutes.queryRows(queryId), {
    query: { offset, limit },
  });
}

/** `DELETE /api/queries/:id` — cancel (propagates to Trino). */
export async function cancelQuery(queryId: string): Promise<void> {
  const res = await fetch(apiRoutes.query(queryId), { method: 'DELETE' });
  // A 404 (already swept) is fine; anything else is surfaced by the caller's
  // optimistic state, so we don't throw here.
  void res;
}

/** Download compression formats exposed in the UI. */
export type DownloadFormat = 'csv' | 'zip';

/** Build the CSV download URL (used directly as an `a[href]` for streaming). */
export function downloadCsvUrl(queryId: string, format: DownloadFormat): string {
  const base = apiRoutes.queryDownloadCsv(queryId);
  return format === 'zip' ? `${base}?compression=zip` : base;
}

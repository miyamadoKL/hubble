// Query-history fetcher (design.md §7). `GET /api/history?offset&limit&state=`
// returns a paged envelope `{ items, offset, limit, total }`. Paging policy
// (offset stepping, page size) lives in the panel's reducer, not here.

import {
  historyResponseSchema,
  type HistoryResponse,
  type QueryState,
  apiRoutes,
} from '@hubble/contracts';
import { apiFetch } from './client';

/** Default page size for the history panel (design.md §5: ページング 50 件). */
export const HISTORY_PAGE_SIZE = 50;

export interface HistoryQuery {
  offset?: number;
  limit?: number;
  /** Filter by terminal/running state; omit for all. */
  state?: QueryState;
}

/** Fetch a page of query history. */
export function fetchHistory(params: HistoryQuery = {}): Promise<HistoryResponse> {
  const { offset = 0, limit = HISTORY_PAGE_SIZE, state } = params;
  return apiFetch(historyResponseSchema, apiRoutes.history(), {
    query: { offset, limit, state },
  });
}

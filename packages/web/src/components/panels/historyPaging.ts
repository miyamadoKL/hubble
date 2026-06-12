// Pure reducer for the History panel's offset paging (design.md §5: offset
// ページング 50 件, もっと見る). Pages are appended as they arrive; switching the
// state filter resets the accumulator. Kept framework-free so it can be unit
// tested directly (design.md §9: 履歴ページング reducer のテスト).

import type { QueryHistoryEntry, QueryState } from '@hue-fable/contracts';

export type HistoryFilter = 'all' | QueryState;

export interface HistoryPagingState {
  /** The active state filter (drives the request's `state=` param). */
  filter: HistoryFilter;
  /** Accumulated entries across the loaded pages, in server order. */
  items: QueryHistoryEntry[];
  /** Next offset to request. */
  offset: number;
  /** Total matching rows reported by the server (for "has more"). */
  total: number;
}

export type HistoryPagingAction =
  | { type: 'reset'; filter: HistoryFilter }
  | { type: 'pageLoaded'; offset: number; items: QueryHistoryEntry[]; total: number };

export function initialPagingState(filter: HistoryFilter = 'all'): HistoryPagingState {
  return { filter, items: [], offset: 0, total: 0 };
}

/**
 * Apply a page result. A page whose `offset` is 0 (a fresh load or a refetch of
 * the first page) replaces the accumulator; later offsets append, de-duplicating
 * by id so an overlapping refetch can't double-insert.
 */
export function historyPagingReducer(
  state: HistoryPagingState,
  action: HistoryPagingAction,
): HistoryPagingState {
  switch (action.type) {
    case 'reset':
      return initialPagingState(action.filter);
    case 'pageLoaded': {
      const base = action.offset === 0 ? [] : state.items;
      const seen = new Set(base.map((e) => e.id));
      const merged = [...base];
      for (const entry of action.items) {
        if (!seen.has(entry.id)) {
          seen.add(entry.id);
          merged.push(entry);
        }
      }
      return {
        filter: state.filter,
        items: merged,
        offset: merged.length,
        total: action.total,
      };
    }
    default:
      return state;
  }
}

/** Whether more rows remain to load beyond what's accumulated. */
export function hasMore(state: HistoryPagingState): boolean {
  return state.items.length < state.total;
}

/** Map a UI filter to the request's `state=` param (undefined for "all"). */
export function filterToStateParam(filter: HistoryFilter): QueryState | undefined {
  return filter === 'all' ? undefined : filter;
}

/**
 * The next offset to request given how many rows are already loaded and the
 * server's `total`, or undefined when everything is loaded. This is the same
 * paging math the reducer applies, lifted out for `useInfiniteQuery`'s
 * `getNextPageParam` (and unit tested directly).
 */
export function nextOffset(loaded: number, total: number): number | undefined {
  return loaded < total ? loaded : undefined;
}

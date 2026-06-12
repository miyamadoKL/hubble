// Live Query Guard estimate hook (Query Guard feature).
//
// Fetches `POST /api/queries/estimate` for a single resolved statement via
// TanStack Query, keyed by (statement, catalog, schema) so the same statement is
// never re-estimated within the cache window — both across cells and across the
// debounced keystrokes of one cell. The server holds a 30s estimate cache; we
// mirror it with `staleTime` so a re-render or a repeated statement is a no-op.
//
// The *decision to call* lives in the caller (SqlCell): it only passes a
// `statement` once the cell parses clean, all variables resolve, and the guard
// is on. Passing `statement: null` keeps the query disabled (so a syntax error
// or `mode=off` simply never fetches).

import { useQuery } from '@tanstack/react-query';
import type { EstimateResult } from '@hubble/contracts';
import { estimateQuery } from '../execution/estimate';

/** Mirror the server's 30s estimate cache so identical statements don't refetch. */
export const ESTIMATE_STALE_MS = 30_000;

export interface UseEstimateParams {
  /** The exact statement to estimate (post variable-substitution + auto-LIMIT), or null to disable. */
  statement: string | null;
  catalog?: string;
  schema?: string;
}

/** TanStack Query key for an estimate — stable per resolved statement + context. */
export function estimateQueryKey(params: UseEstimateParams) {
  return ['estimate', params.catalog ?? '', params.schema ?? '', params.statement] as const;
}

/**
 * Live estimate for the supplied statement. Disabled (no request) when
 * `statement` is null. Returns the standard TanStack Query result; the data is
 * an `EstimateResult` once it resolves.
 */
export function useEstimate(params: UseEstimateParams) {
  const enabled = params.statement !== null && params.statement.length > 0;
  return useQuery<EstimateResult>({
    queryKey: estimateQueryKey(params),
    queryFn: () =>
      estimateQuery({
        statement: params.statement as string,
        catalog: params.catalog,
        schema: params.schema,
      }),
    enabled,
    staleTime: ESTIMATE_STALE_MS,
    // A live estimate is advisory — a transient failure should fall back to the
    // server's enforce wall, not spam retries while the user types.
    retry: false,
    // Keep the previous estimate visible while a new (debounced) statement
    // estimates, avoiding a flash to empty between keystrokes.
    placeholderData: (prev) => prev,
  });
}

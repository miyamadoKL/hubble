// Current identity (`GET /api/me`) via TanStack Query (design.md §11). Drives
// the TopBar user chip (hidden in `none` mode) and is the canonical signal for
// the global "authentication required" screen: a 401 here means the proxy
// session is missing or expired.

import { useQuery } from '@tanstack/react-query';
import { UNAUTHENTICATED, type MeResponse } from '@hue-fable/contracts';
import { ApiClientError, fetchMe } from '../api/client';

export const meQueryKey = ['me'] as const;

export function useMe() {
  return useQuery<MeResponse, ApiClientError>({
    queryKey: meQueryKey,
    queryFn: fetchMe,
    staleTime: Infinity,
    // Don't hammer the server on a 401 — surface it to the auth screen instead.
    retry: (failureCount, error) => {
      if (error instanceof ApiClientError && error.detail.code === UNAUTHENTICATED) return false;
      return failureCount < 1;
    },
  });
}

/** True when the `/api/me` request failed with the UNAUTHENTICATED code. */
export function isUnauthenticated(error: unknown): boolean {
  return error instanceof ApiClientError && error.detail.code === UNAUTHENTICATED;
}

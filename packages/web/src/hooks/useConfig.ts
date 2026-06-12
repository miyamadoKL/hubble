// App config (`GET /api/config`) via TanStack Query (design.md §7). Exposes the
// server defaults — notably `defaults.limit`, the LIMIT auto-append value used
// by the execution layer. Config is effectively static for a session, so it is
// cached aggressively.

import { useQuery } from '@tanstack/react-query';
import type { AppConfig } from '@hubble/contracts';
import { fetchConfig } from '../api/client';

export const configQueryKey = ['config'] as const;

/** Fallback default LIMIT when the config request hasn't resolved yet. */
export const FALLBACK_LIMIT = 5000;

export function useConfig() {
  return useQuery<AppConfig>({
    queryKey: configQueryKey,
    queryFn: fetchConfig,
    staleTime: Infinity,
    retry: 1,
  });
}

/** The default LIMIT, falling back to {@link FALLBACK_LIMIT}. */
export function useDefaultLimit(): number {
  const { data } = useConfig();
  return data?.defaults.limit ?? FALLBACK_LIMIT;
}

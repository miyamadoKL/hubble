// App config (`GET /api/config`) via TanStack Query (design.md §7). Exposes the
// server defaults — notably `defaults.limit`, the LIMIT auto-append value used
// by the execution layer. Config is effectively static for a session, so it is
// cached aggressively.

import { useQuery } from '@tanstack/react-query';
import type { AppConfig, GuardConfig } from '@hubble/contracts';
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

/** Guard config, defaulting to a safe `off` until /api/config resolves. */
const GUARD_OFF: GuardConfig = {
  mode: 'off',
  maxScanBytes: 0,
  maxScanRows: 0,
  onUnknown: 'allow',
  bytesPerSecond: 0,
};

/** The active Query Guard config (design.md / Query Guard feature). */
export function useGuardConfig(): GuardConfig {
  const { data } = useConfig();
  return data?.guard ?? GUARD_OFF;
}

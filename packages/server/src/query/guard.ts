import type { EstimateResult } from '@hubble/contracts';
import type { ServerConfig } from '../config';

/**
 * Small Query Guard helpers shared by the HTTP layer (Query Guard feature):
 * the canned `disabled` estimate and the limits snapshot embedded in a
 * `QUERY_BLOCKED` error's `details`.
 */

/** The estimate returned (without touching Trino) when the guard is off. */
export function disabledEstimate(): EstimateResult {
  return {
    status: 'disabled',
    scanBytes: null,
    scanRows: null,
    outputRows: null,
    outputBytes: null,
    estimatedSeconds: null,
    tables: [],
    verdict: { decision: 'allow', reasons: [] },
    elapsedMs: 0,
  };
}

/** The active guard limits, surfaced to the web alongside a block. */
export function guardLimitsSnapshot(config: ServerConfig): {
  mode: ServerConfig['guard']['mode'];
  maxScanBytes: number;
  maxScanRows: number;
  onUnknown: ServerConfig['guard']['onUnknown'];
} {
  return {
    mode: config.guard.mode,
    maxScanBytes: config.guard.maxScanBytes,
    maxScanRows: config.guard.maxScanRows,
    onUnknown: config.guard.onUnknown,
  };
}

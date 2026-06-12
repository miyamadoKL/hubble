import type { QueryColumn, QueryStats } from '@hue-fable/contracts';

/**
 * Raw shapes returned by Trino's `/v1/statement` REST protocol.
 * We only model the fields we consume.
 */

export interface TrinoColumn {
  name: string;
  type: string;
}

export interface TrinoErrorLocation {
  lineNumber: number;
  columnNumber: number;
}

export interface TrinoError {
  message: string;
  errorCode?: number;
  errorName?: string;
  errorType?: string;
  errorLocation?: TrinoErrorLocation;
}

export interface TrinoStats {
  state: string;
  queued?: boolean;
  scheduled?: boolean;
  progressPercentage?: number;
  nodes?: number;
  totalSplits?: number;
  queuedSplits?: number;
  runningSplits?: number;
  completedSplits?: number;
  processedRows?: number;
  processedBytes?: number;
  wallTimeMillis?: number;
  elapsedTimeMillis?: number;
  peakMemoryBytes?: number;
}

/** A single response page from `/v1/statement` (POST result or a `nextUri` GET). */
export interface TrinoStatementResponse {
  id: string;
  infoUri?: string;
  nextUri?: string;
  columns?: TrinoColumn[];
  data?: unknown[][];
  stats: TrinoStats;
  error?: TrinoError;
}

/**
 * Session mutations parsed from `x-trino-set-*` / `x-trino-clear-session`
 * response headers. Applied to the session snapshot on query completion so
 * `SET CATALOG`/`SET SCHEMA`/`SET SESSION` follow-on queries inherit them.
 */
export interface TrinoSessionMutations {
  setCatalog?: string;
  setSchema?: string;
  /** session property name -> value (added/changed). */
  setSession: Record<string, string>;
  /** session property names to clear. */
  clearSession: string[];
}

/** Parameters for issuing a statement against Trino. */
export interface TrinoRequestContext {
  catalog?: string;
  schema?: string;
  source?: string;
  /**
   * `X-Trino-User` override for impersonation (design.md §11). When set, the
   * statement runs as this principal instead of the client's technical user.
   * Metadata queries leave this unset and use the technical user.
   */
  user?: string;
  /** Session properties, forwarded as `X-Trino-Session: k=v,...`. */
  sessionProperties?: Record<string, string>;
}

export function emptySessionMutations(): TrinoSessionMutations {
  return { setSession: {}, clearSession: [] };
}

/** Map a Trino column list to the contract `QueryColumn[]`. */
export function toQueryColumns(columns: TrinoColumn[] | undefined): QueryColumn[] {
  if (!columns) return [];
  return columns.map((c) => ({ name: c.name, type: c.type }));
}

/**
 * Map Trino stats to the contract `QueryStats`. Fields absent in the Trino
 * payload default to 0 (the contract requires them as non-negative ints).
 */
export function toQueryStats(stats: TrinoStats): QueryStats {
  return {
    progressPercentage:
      stats.progressPercentage === undefined
        ? undefined
        : Math.max(0, Math.min(100, stats.progressPercentage)),
    state: stats.state,
    queuedSplits: stats.queuedSplits ?? 0,
    runningSplits: stats.runningSplits ?? 0,
    completedSplits: stats.completedSplits ?? 0,
    totalSplits: stats.totalSplits ?? 0,
    processedRows: stats.processedRows ?? 0,
    processedBytes: stats.processedBytes ?? 0,
    wallTimeMillis: stats.wallTimeMillis ?? 0,
    elapsedTimeMillis: stats.elapsedTimeMillis ?? 0,
    peakMemoryBytes: stats.peakMemoryBytes ?? 0,
    nodes: stats.nodes,
  };
}

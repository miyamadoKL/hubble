// Query Guard estimate layer (Query Guard feature).
//
// Three concerns, all pure / synchronous except the one fetch helper:
//   - estimateQuery        : POST /api/queries/estimate (typed, zod-validated)
//   - resolveEstimateInput : build the *exact* statement the run path will send
//                            (variable substitution + auto-LIMIT) or a skip
//                            reason — so the estimate matches the run byte-for-byte
//                            and hits the server's (principal,…,statement) cache.
//   - estimatePresentation : map an EstimateResult to a compact UI descriptor
//                            (tone / label / whether to show / whether to block).
//   - parseQueryBlocked    : pull the typed { estimate, limits } out of a 422
//                            QUERY_BLOCKED error's `details` for the ErrorPanel.
//
// Everything here is editor-agnostic and exercised directly by vitest.

import {
  estimateRequestSchema,
  estimateResultSchema,
  guardConfigSchema,
  type ApiErrorDetail,
  type EstimateResult,
  type GuardConfig,
  type GuardDecision,
} from '@hubble/contracts';
import { apiFetch, apiRoutes } from '../api/client';
import { substituteVariables } from '../notebook/variables';
import { withAutoLimit } from './sql';
import { resolveExecution, type CaretSelection } from './executionUnit';

/** `POST /api/queries/estimate` → an `EstimateResult`. */
export function estimateQuery(request: {
  statement: string;
  catalog?: string;
  schema?: string;
}): Promise<EstimateResult> {
  const body = estimateRequestSchema.parse(request);
  return apiFetch(estimateResultSchema, apiRoutes.queryEstimate(), { method: 'POST', body });
}

/** Inputs that mirror a run, so the estimated statement is identical to it. */
export interface ResolveEstimateInput {
  /** The raw statement text of the execution unit (pre-substitution). */
  unitText: string;
  /** Notebook variable values, name → current value. */
  variableValues: Record<string, string>;
  /** Auto-LIMIT toggle + value, exactly as the run path uses them. */
  autoLimit: boolean;
  limit: number;
}

/** Why an estimate was skipped (kept out of the request entirely). */
export type EstimateSkipReason = 'empty' | 'missing-variables';

export type ResolveEstimateResult =
  | { ok: true; statement: string }
  | { ok: false; reason: EstimateSkipReason };

/**
 * Produce the statement that an estimate should be run against — identical to
 * the one the execution store will send (`executionStore.runUnit`): variables
 * substituted first, then `withAutoLimit` applied when the toggle is on. A unit
 * with unresolved `${…}` variables is *not* estimated (the run would be blocked
 * by the same missing-variable check), and neither is an empty unit.
 */
export function resolveEstimateInput(input: ResolveEstimateInput): ResolveEstimateResult {
  const trimmed = input.unitText.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };

  const { text, missing } = substituteVariables(input.unitText, input.variableValues);
  if (missing.length > 0) return { ok: false, reason: 'missing-variables' };

  const statement = input.autoLimit ? withAutoLimit(text, input.limit).sql : text;
  return { ok: true, statement };
}

/** Why the live estimate was skipped (so the strip can decide to hide). */
export type LiveEstimateSkip =
  | 'guard-off' // mode=off — never call the API
  | 'empty' // nothing under the caret / selection
  | 'parse-error' // the unit doesn't parse cleanly yet (user mid-edit)
  | 'missing-variables'; // unresolved ${…} — the run itself would be blocked

export type LiveEstimateTarget =
  | { estimate: true; statement: string }
  | { estimate: false; reason: LiveEstimateSkip };

export interface LiveEstimateInput {
  /** Full cell source. */
  source: string;
  /** Current selection/caret (the run path's `resolveExecution` input). */
  selection: CaretSelection;
  /** Notebook variable values. */
  variableValues: Record<string, string>;
  /** Auto-LIMIT toggle + value, identical to the run path. */
  autoLimit: boolean;
  limit: number;
  /** Guard mode from /api/config — 'off' skips estimation entirely. */
  guardMode: 'off' | 'warn' | 'enforce';
  /**
   * Parse-cleanliness predicate over the *resolved* statement, true when the
   * ANTLR parser produced no error markers. Injected so this stays pure/testable
   * (the editor wires in `parseStatement(...).markers.length === 0`).
   */
  parsesClean: (statement: string) => boolean;
}

/**
 * Decide what (if anything) to estimate for the cell's current caret/selection,
 * applying the user's rule "estimate only when it parses": guard on, a non-empty
 * unit, all variables resolved, and the resolved statement parses clean. The
 * statement returned is byte-identical to what the run path would send (variable
 * substitution then auto-LIMIT), so it hits the server's estimate cache and the
 * run-time block is consistent with what the strip showed.
 */
export function computeLiveEstimateTarget(input: LiveEstimateInput): LiveEstimateTarget {
  if (input.guardMode === 'off') return { estimate: false, reason: 'guard-off' };

  const units = resolveExecution(input.source, input.selection);
  const unit = units[0];
  if (!unit || unit.text.trim().length === 0) return { estimate: false, reason: 'empty' };

  const resolved = resolveEstimateInput({
    unitText: unit.text,
    variableValues: input.variableValues,
    autoLimit: input.autoLimit,
    limit: input.limit,
  });
  if (!resolved.ok) {
    return { estimate: false, reason: resolved.reason === 'empty' ? 'empty' : 'missing-variables' };
  }

  // Parse the *substituted, pre-auto-LIMIT* unit text — substitution can change
  // validity (e.g. `${n}` → a number), and the appended LIMIT is always valid.
  const { text: substituted } = substituteVariables(unit.text, input.variableValues);
  if (!input.parsesClean(substituted)) return { estimate: false, reason: 'parse-error' };

  return { estimate: true, statement: resolved.statement };
}

/** Visual tone of the estimate strip, mapped 1:1 to a design token family. */
export type EstimateTone = 'info' | 'warning' | 'error' | 'unavailable';

/** Compact UI descriptor derived from an `EstimateResult` + the guard config. */
export interface EstimatePresentation {
  /** Whether the strip should render at all. */
  visible: boolean;
  /** Tone driving the strip's color (design token family). */
  tone: EstimateTone;
  /** True when the run must be blocked (decision === 'block'). */
  blocked: boolean;
  /** Scan figures to display, when known. */
  scanRows: number | null;
  scanBytes: number | null;
  /** Time estimate, only when the server provided one. */
  estimatedSeconds: number | null;
  /** Short status word shown in the strip ('estimate' | 'estimate unavailable'). */
  label: string;
  /** Human-readable reasons (warn/block), surfaced in a tooltip / inline. */
  reasons: string[];
}

const HIDDEN: EstimatePresentation = {
  visible: false,
  tone: 'info',
  blocked: false,
  scanRows: null,
  scanBytes: null,
  estimatedSeconds: null,
  label: '',
  reasons: [],
};

/** Map a guard decision to the strip's tone. */
function toneForDecision(decision: GuardDecision): EstimateTone {
  if (decision === 'block') return 'error';
  if (decision === 'warn') return 'warning';
  return 'info';
}

/**
 * Map an estimate result to its compact strip presentation.
 *
 *  - `disabled` / `unsupported`  → hidden (nothing to say).
 *  - `unavailable`               → a muted "estimate unavailable", escalated to
 *                                  warn/block tone when the verdict asks for it.
 *  - `estimated`                 → scan figures + the verdict's tone.
 */
export function estimatePresentation(result: EstimateResult): EstimatePresentation {
  if (result.status === 'disabled' || result.status === 'unsupported') {
    return HIDDEN;
  }

  const decision = result.verdict.decision;
  const blocked = decision === 'block';

  if (result.status === 'unavailable') {
    return {
      visible: true,
      tone: decision === 'allow' ? 'unavailable' : toneForDecision(decision),
      blocked,
      scanRows: null,
      scanBytes: null,
      estimatedSeconds: null,
      label: 'estimate unavailable',
      reasons: result.verdict.reasons,
    };
  }

  // status === 'estimated'
  return {
    visible: true,
    tone: toneForDecision(decision),
    blocked,
    scanRows: result.scanRows,
    scanBytes: result.scanBytes,
    estimatedSeconds: result.estimatedSeconds,
    label: 'estimated scan',
    reasons: result.verdict.reasons,
  };
}

/** The structured payload a 422 `QUERY_BLOCKED` error carries in `details`. */
export interface QueryBlockedDetails {
  estimate: EstimateResult;
  limits: GuardConfig;
}

const partialGuardConfig = guardConfigSchema.partial();

/**
 * Extract a typed `{ estimate, limits }` from a `QUERY_BLOCKED` error detail.
 * Returns undefined for any other error (or a malformed payload), so callers
 * can fall back to the plain message. Tolerant of a partial `limits` snapshot
 * (the server omits `bytesPerSecond` in the block snapshot).
 */
export function parseQueryBlocked(error: ApiErrorDetail): QueryBlockedDetails | undefined {
  if (error.code !== 'QUERY_BLOCKED' || !error.details) return undefined;
  const raw = error.details as { estimate?: unknown; limits?: unknown };
  const estimate = estimateResultSchema.safeParse(raw.estimate);
  if (!estimate.success) return undefined;
  const limits = partialGuardConfig.safeParse(raw.limits ?? {});
  return {
    estimate: estimate.data,
    limits: {
      maxScanBytes: 0,
      maxScanRows: 0,
      bytesPerSecond: 0,
      mode: 'enforce',
      onUnknown: 'warn',
      ...(limits.success ? limits.data : {}),
    },
  };
}

/** True when an error detail is a Query Guard block (422 QUERY_BLOCKED). */
export function isQueryBlocked(error: ApiErrorDetail | undefined): boolean {
  return error?.code === 'QUERY_BLOCKED';
}

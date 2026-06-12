import type { ScheduleRunStatus, ScheduleRunSummary } from '@hubble/contracts';
import { parseStatement } from '../../trino-lang';
import { ApiClientError } from '../../api/client';

/**
 * Pure presentation + validation helpers for the Query Scheduling panels, kept
 * out of the React components so they can be unit-tested in isolation:
 *   - run-status → tone / label (drives the status pill colors via design tokens)
 *   - client-side SQL syntax check (the run-prevention UI; mirrors the server's
 *     EXPLAIN VALIDATE so the save button disables before a round-trip)
 *   - server VALIDATION_ERROR → a flat, human-readable form error
 *   - cron presets for the create/edit form
 *   - retry-field clamping against the contract's documented ranges
 */

/** Semantic tone for a run status, mapped to design-token color classes. */
export type RunTone = 'running' | 'success' | 'error' | 'warning' | 'neutral';

const STATUS_TONE: Record<ScheduleRunStatus, RunTone> = {
  running: 'running',
  success: 'success',
  failed: 'error',
  aborted: 'neutral',
  blocked: 'warning',
};

const STATUS_LABEL: Record<ScheduleRunStatus, string> = {
  running: 'RUNNING',
  success: 'SUCCESS',
  failed: 'FAILED',
  aborted: 'ABORTED',
  blocked: 'BLOCKED',
};

export function runTone(status: ScheduleRunStatus): RunTone {
  return STATUS_TONE[status];
}

export function runStatusLabel(status: ScheduleRunStatus): string {
  return STATUS_LABEL[status];
}

/**
 * A one-line summary of a run's outcome for the schedule list's "last run" cell.
 * Surfaces the retry count when a failure exhausted more than one attempt so the
 * list reads "Failed · 3 attempts" without opening the history view.
 */
export function summarizeLastRun(run: ScheduleRunSummary): string {
  const label =
    STATUS_LABEL[run.status].charAt(0) + STATUS_LABEL[run.status].slice(1).toLowerCase();
  if (run.status === 'failed' && run.attempt > 1) {
    return `${label} · ${run.attempt} attempts`;
  }
  return label;
}

/** Human "N attempts" phrasing for the history view (singular-aware). */
export function attemptLabel(attempt: number): string {
  return attempt === 1 ? '1 attempt' : `${attempt} attempts`;
}

// ---- Client-side statement syntax check (run-prevention UI) -----------------

export interface StatementCheck {
  ok: boolean;
  /** First syntax error message, when the statement does not parse. */
  message?: string;
  line?: number;
  column?: number;
}

/**
 * Parse a statement with the in-browser trino-lang analyzer and surface the
 * first syntax marker. Empty input is treated as not-ok (the form requires a
 * statement) but without an error message, so the field reads as "required"
 * rather than "broken".
 */
export function checkStatement(
  statement: string,
  catalog?: string,
  schema?: string,
): StatementCheck {
  if (!statement.trim()) return { ok: false };
  const { markers } = parseStatement(statement, catalog, schema);
  const first = markers[0];
  if (!first) return { ok: true };
  return {
    ok: false,
    message: first.message,
    line: first.startLineNumber,
    column: first.startColumn,
  };
}

// ---- Server VALIDATION_ERROR formatting -------------------------------------

export interface FormError {
  message: string;
  /** Trino's underlying message, when the server forwarded one. */
  trinoMessage?: string;
  line?: number;
  column?: number;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Flatten an `ApiClientError` into a form-friendly error. For the server's
 * VALIDATION_ERROR (Trino syntax errors at create/update time) it pulls the
 * `details.{trinoMessage,line,column}` payload so the form can echo the exact
 * line/column the cluster rejected. Other errors fall back to the envelope
 * message.
 */
export function formatApiError(error: unknown): FormError {
  if (error instanceof ApiClientError) {
    const detail = error.detail;
    const details = detail.details ?? {};
    const trinoMessage = asString(details.trinoMessage);
    const line = asNumber(details.line) ?? detail.line;
    const column = asNumber(details.column) ?? detail.column;
    return { message: detail.message, trinoMessage, line, column };
  }
  return { message: error instanceof Error ? error.message : 'Request failed' };
}

// ---- Cron presets -----------------------------------------------------------

export interface CronPreset {
  label: string;
  cron: string;
}

/** A small set of common cadences offered as one-click presets in the form. */
export const CRON_PRESETS: CronPreset[] = [
  { label: 'Every minute', cron: '* * * * *' },
  { label: 'Hourly (on the hour)', cron: '0 * * * *' },
  { label: 'Daily at 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 08:00', cron: '0 8 * * 1-5' },
  { label: 'Mondays at 09:00', cron: '0 9 * * 1' },
];

// ---- Retry field clamping ---------------------------------------------------

/** Inclusive [min, max] bounds for the retry fields (from the contract). */
export const RETRY_BOUNDS = {
  maxAttempts: { min: 1, max: 10 },
  backoffSeconds: { min: 1, max: 3600 },
  backoffMultiplier: { min: 1, max: 10 },
} as const;

export type RetryField = keyof typeof RETRY_BOUNDS;

/**
 * Clamp a (possibly NaN) numeric retry input into its contract range, rounding
 * to an integer. NaN falls back to the lower bound so a cleared field never
 * produces an out-of-range request body.
 */
export function clampRetryField(field: RetryField, value: number): number {
  const { min, max } = RETRY_BOUNDS[field];
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

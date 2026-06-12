import { CronExpressionParser } from 'cron-parser';

/**
 * Cron helpers for the scheduler (Query Scheduling feature). The next-run time
 * is always computed relative to "now" (never relative to the last run), so a
 * server that was stopped across one or more fire times simply resumes at the
 * next future occurrence — missed runs are skipped, not backfilled (per design).
 *
 * Expressions are 5-field standard cron and evaluated in the server's local
 * timezone (cron-parser's default when no `tz` is given).
 */

/**
 * True if `cron` is a parseable cron expression. The exact 5-field shape is
 * enforced by the contract (`cronExpression` in @hubble/contracts); this helper
 * additionally rejects empty/blank input, which cron-parser would otherwise
 * treat as "every minute".
 */
export function isValidCron(cron: string): boolean {
  if (cron.trim() === '') return false;
  try {
    CronExpressionParser.parse(cron);
    return true;
  } catch {
    return false;
  }
}

/**
 * The next fire time strictly after `from`, as epoch milliseconds, or null when
 * the expression is invalid or has no future occurrence. Evaluated in local TZ.
 */
export function nextRunAfter(cron: string, from: Date): number | null {
  try {
    const it = CronExpressionParser.parse(cron, { currentDate: from });
    return it.next().toDate().getTime();
  } catch {
    return null;
  }
}

/** Convenience: next fire time as an ISO string, or null. */
export function nextRunIso(cron: string, from: Date): string | null {
  const ms = nextRunAfter(cron, from);
  return ms === null ? null : new Date(ms).toISOString();
}

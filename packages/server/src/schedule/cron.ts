import { CronExpressionParser } from 'cron-parser';

/**
 * Cron helpers for the scheduler (Query Scheduling feature). The next-run time
 * is always computed relative to "now" (never relative to the last run), so a
 * server that was stopped across one or more fire times simply resumes at the
 * next future occurrence — missed runs are skipped, not backfilled (per design).
 *
 * Expressions are 5-field standard cron and evaluated in the server's local
 * timezone (cron-parser's default when no `tz` is given).
 *
 * 日本語: このファイルは cron 式のパース/検証と「次回発火時刻の計算」のみを担う薄い
 * ラッパー。実体は `cron-parser` パッケージに委譲する。scheduler.ts の tick ループが
 * `nextRunAfter` を呼び、常に「現在時刻」を基準に次回発火時刻を求め直すため、
 * サーバー停止期間中に発火時刻を跨いでも取りこぼした分は実行されず (バックフィルなし)、
 * 次の未来の発火だけが予約される。この「now を基準にバックフィルしない」方針が
 * このファイル全体の設計意図。
 */

/**
 * True if `cron` is a parseable cron expression. The exact 5-field shape is
 * enforced by the contract (`cronExpression` in @hubble/contracts); this helper
 * additionally rejects empty/blank input, which cron-parser would otherwise
 * treat as "every minute".
 *
 * 日本語: 主に schedule 作成/更新時の入力検証に使う。空文字/空白のみは
 * cron-parser がデフォルトで「毎分」として受理してしまうため、ここで明示的に弾く。
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
 *
 * 日本語: `from` を基準時刻として cron-parser にイテレータを作らせ、その `next()`
 * (=from より厳密に後の最初の発火時刻) を epoch ミリ秒で返す。scheduler.ts はこれを
 * 「現在時刻」を `from` として呼び出すことで、サーバー再起動後も未来の発火だけを
 * 予約する。式が不正、あるいは (理論上) 未来の発火が存在しない場合は null を返す。
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
// 日本語: nextRunAfter の結果を ISO 8601 文字列に変換するだけの薄いラッパー。
// API レスポンスや schedule_runs.scheduled_for のような文字列表現が必要な箇所で使う。
export function nextRunIso(cron: string, from: Date): string | null {
  const ms = nextRunAfter(cron, from);
  return ms === null ? null : new Date(ms).toISOString();
}

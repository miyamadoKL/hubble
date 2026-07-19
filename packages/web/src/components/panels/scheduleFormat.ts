/**
 * クエリスケジューラー機能（Schedules 系パネル群）で共有する、UI を持たない
 * 純粋なヘルパー関数集。React コンポーネントから切り離すことで、単体テストで
 * ロジックだけを検証できるようにしてある。主な役割は次の 4 つ。
 *   1. 実行 run の status → 表示トーン（色）/ ラベル文字列への変換
 *   2. サーバーが返す VALIDATION_ERROR をフォーム表示用の平坦なオブジェクトへ変換
 *   3. 作成と編集のフォームで使う cron プリセットの定義
 *   4. リトライ設定の数値フィールドをコントラクトで定義された範囲にクランプする処理
 * SQL 文は常に参照先の保存済みクエリが持つ値であり schedule フォームでは編集しないため、
 * クライアント側の構文チェック（旧 checkStatement）はここには無い。
 */
import type { ScheduleRunStatus, ScheduleRunSummary } from '@hubble/contracts';
import { ApiClientError } from '../../api/client';
import { t } from '../../i18n/t';
import { scheduleRunMessages } from '../../i18n/messages/scheduleRun';
import type { Locale } from '../../i18n/locale';

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
// 実行結果の状態を、色として意味づけられた「トーン」に分類する型。
// running=進行中, success=成功, error=失敗, warning=中断/ブロック相当, neutral=中立。
export type RunTone = 'running' | 'success' | 'error' | 'warning' | 'neutral';

// ScheduleRunStatus の各値をトーン（色分類）へマッピングするテーブル。
const STATUS_TONE: Record<ScheduleRunStatus, RunTone> = {
  running: 'running',
  success: 'success',
  failed: 'error',
  aborted: 'neutral',
  blocked: 'warning',
};

// ScheduleRunStatus の各値を辞書のキーへマッピングするテーブル（表示は
// scheduleRunMessages 側でロケール別に持つ。契約値である ScheduleRunStatus 自体は
// 変更しない）。
const STATUS_LABEL_KEY = {
  running: 'statusRunning',
  success: 'statusSuccess',
  failed: 'statusFailed',
  aborted: 'statusAborted',
  blocked: 'statusBlocked',
} as const satisfies Record<ScheduleRunStatus, keyof typeof scheduleRunMessages>;

// summarizeLastRun 用の英語限定ラベル（この関数自体が現在どの画面からも呼ばれていない
// dead code のため、フルの多言語化はスコープ外とし、既存のテスト互換のみ保つ）。
const STATUS_LABEL_EN: Record<ScheduleRunStatus, string> = {
  running: 'RUNNING',
  success: 'SUCCESS',
  failed: 'FAILED',
  aborted: 'ABORTED',
  blocked: 'BLOCKED',
};

/** run の status からステータスバッジの色トーンを求める。 */
export function runTone(status: ScheduleRunStatus): RunTone {
  return STATUS_TONE[status];
}

/**
 * run の status から画面表示用のラベル文字列を求める。契約値
 * （running/success/failed/aborted/blocked）自体は変更せず、表示だけ翻訳する。
 * `locale` 省略時は 'en'（既存呼び出し元との後方互換用のデフォルト値。UI から呼ぶ場合は
 * `useLocale()` で得た現在のロケールを明示的に渡す）。
 */
export function runStatusLabel(status: ScheduleRunStatus, locale: Locale = 'en'): string {
  return t(scheduleRunMessages, STATUS_LABEL_KEY[status], locale);
}

/**
 * A one-line summary of a run's outcome for the schedule list's "last run" cell.
 * Surfaces the retry count when a failure exhausted more than one attempt so the
 * list reads "Failed · 3 attempts" without opening the history view.
 */
export function summarizeLastRun(run: ScheduleRunSummary): string {
  // ラベルは先頭大文字+残り小文字（例: "Failed"）に整形して表示用の文とする。
  const label =
    STATUS_LABEL_EN[run.status].charAt(0) + STATUS_LABEL_EN[run.status].slice(1).toLowerCase();
  // 失敗かつ複数回試行していた場合のみ、試行回数を併記する（例: "Failed · 3 attempts"）。
  if (run.status === 'failed' && run.attempt > 1) {
    return `${label} · ${run.attempt} attempts`;
  }
  return label;
}

/**
 * 実行履歴の試行回数表記（「N attempts」等）を求める。1 回だけなら単数形、複数回
 * なら複数形と、日英それぞれの単数/複数を正しく出し分ける。
 * `locale` 省略時は 'en'（既存呼び出し元との後方互換用のデフォルト値）。
 */
export function attemptLabel(attempt: number, locale: Locale = 'en'): string {
  return attempt === 1
    ? t(scheduleRunMessages, 'attemptSingular', locale)
    : t(scheduleRunMessages, 'attemptPlural', locale, { n: attempt });
}

// ---- Server VALIDATION_ERROR formatting -------------------------------------

/** フォーム表示用に正規化したサーバー側エラー情報。 */
export interface FormError {
  message: string;
  /** Trino's underlying message, when the server forwarded one. */
  trinoMessage?: string;
  line?: number;
  column?: number;
}

// unknown な値が「有限数」の場合のみ数値として取り出すユーティリティ。
function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// unknown な値が「空でない文字列」の場合のみ文字列として取り出すユーティリティ。
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
    // サーバーのエラーエンベロープから detail.details（VALIDATION_ERROR 特有の
    // trinoMessage / line / column）を優先的に取り出し、無ければ detail 直下の
    // line / column にフォールバックする。
    const detail = error.detail;
    const details = detail.details ?? {};
    const trinoMessage = asString(details.trinoMessage);
    const line = asNumber(details.line) ?? detail.line;
    const column = asNumber(details.column) ?? detail.column;
    return { message: detail.message, trinoMessage, line, column };
  }
  // ApiClientError 以外（ネットワークエラー等）はメッセージのみのフォールバックにする。
  return { message: error instanceof Error ? error.message : 'Request failed' };
}

// ---- Cron presets -----------------------------------------------------------

/** cron プリセット 1 件分（表示ラベルと実際の cron 式）。 */
export interface CronPreset {
  label: string;
  cron: string;
}

/** A small set of common cadences offered as one-click presets in the form. */
// フォームでワンクリック選択できる、よく使われる実行間隔のプリセット一覧。
export const CRON_PRESETS: CronPreset[] = [
  { label: 'Every minute', cron: '* * * * *' },
  { label: 'Hourly (on the hour)', cron: '0 * * * *' },
  { label: 'Daily at 09:00', cron: '0 9 * * *' },
  { label: 'Weekdays at 08:00', cron: '0 8 * * 1-5' },
  { label: 'Mondays at 09:00', cron: '0 9 * * 1' },
];

// ---- Retry field clamping ---------------------------------------------------

/** Inclusive [min, max] bounds for the retry fields (from the contract). */
// リトライ関連フィールドそれぞれの許容範囲（両端含む）。コントラクト定義と一致させる。
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
  // 入力欄が空文字などで Number() の結果が NaN/非有限になった場合は下限値にフォールバックする。
  if (!Number.isFinite(value)) return min;
  // 整数に丸めたうえで [min, max] の範囲にクランプする。
  return Math.min(max, Math.max(min, Math.round(value)));
}

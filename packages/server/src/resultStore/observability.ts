/**
 * ResultStore の処理時間と入出力量を記録するための型と通知ヘルパー。
 */
import { performance } from 'node:perf_hooks';

/** ResultStore の処理時間を測る単調増加時計。 */
export type ResultStoreClock = () => number;

/** ResultStore の処理結果。 */
export type ResultStoreMetricOutcome = 'success' | 'failure' | 'abort';

/** ResultStore の計測イベント。識別子や入力値は含めない。 */
export type ResultStoreMetric =
  | {
      kind: 'write';
      rows: number;
      uncompressedBytes: number;
      compressedBytes: number;
      durationMs: number;
      outcome: ResultStoreMetricOutcome;
    }
  | {
      kind: 'read';
      operation: 'rows' | 'search' | 'profile';
      scannedRows: number;
      durationMs: number;
      outcome: ResultStoreMetricOutcome;
      offset?: number;
    }
  | {
      kind: 's3-request';
      operation: 'get' | 'delete';
      durationMs: number;
      outcome: ResultStoreMetricOutcome;
      batchSize?: number;
      failedItems?: number;
    };

/** 計測イベントを受け取る任意のobserver。 */
export type ResultStoreObserver = (event: ResultStoreMetric) => void;

/** 計測対象へ渡す任意の依存。 */
export interface ResultStoreMetricOptions {
  observer?: ResultStoreObserver;
  clock?: ResultStoreClock;
}

/** 本番で使う単調増加時計。wall clockの補正に影響されない。 */
export const defaultResultStoreClock: ResultStoreClock = (): number => performance.now();

/** observerの実装不備を本処理へ伝播させずに通知する。 */
export function safeNotifyResultStoreObserver(
  observer: ResultStoreObserver | undefined,
  event: ResultStoreMetric,
): void {
  if (!observer) return;
  try {
    observer(event);
  } catch {
    // 計測系の失敗で結果保存や読み取りを中断しない。
  }
}

/** エラーとsignalから計測上の終了理由を判定する。 */
export function resultStoreErrorOutcome(
  error: unknown,
  signal?: AbortSignal,
): Extract<ResultStoreMetricOutcome, 'failure' | 'abort'> {
  if (signal?.aborted) return 'abort';
  if (error instanceof Error && error.name === 'AbortError') return 'abort';
  return 'failure';
}

/** 時計の差分を負数なしのミリ秒へ正規化する。 */
export function elapsedResultStoreMs(clock: ResultStoreClock, startedAt: number): number {
  return Math.max(clock() - startedAt, 0);
}

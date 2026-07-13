import type { DuckdbProfileFailureCode } from '../resultStore';

/** profile reader の適用可否と結果を表す低カーディナリティの分類。 */
export type DuckdbProfileObservationReason =
  | 'disabled'
  | 'no_parquet'
  | 'non_s3'
  | 'reader_unavailable'
  | 'missing_columns'
  | 'unsupported_encoding'
  | 'expired_parquet'
  | 'object_key_mismatch'
  | 'invalid_s3_prefix'
  | 'invalid_object_key'
  | 'invalid_row_count'
  | 'unsupported_column_type'
  | 'overloaded'
  | 'auth'
  | 'httpfs'
  | 's3'
  | 'timeout'
  | 'schema_mismatch'
  | 'duckdb_error'
  | 'aborted'
  | 'negative_cache';

/** profile の行数を運用メトリクス用に丸めた分類。 */
export type DuckdbProfileRowCountBucket = '0' | '1-999' | '1000-9999' | '10000-99999' | '100000+';

/** profile reader の観測結果。入力値、credential、object URI は含めない。 */
export interface DuckdbProfileObservation {
  route: 'profile';
  outcome: 'success' | 'not_applicable' | 'fallback' | 'aborted';
  reason?: DuckdbProfileObservationReason;
  failureCode?: DuckdbProfileFailureCode;
  totalDurationMs: number;
  queueWaitMs: number;
  duckdbDurationMs: number;
  jsonlFallbackDurationMs: number;
  rowCountBucket: DuckdbProfileRowCountBucket;
  cacheHit: boolean;
}

/** profile reader の typed observer。observer の失敗はリクエストを失敗させない。 */
export interface DuckdbProfileObserver {
  observe(event: DuckdbProfileObservation): void;
}

/** テストと process 内 metrics 集計で使う profile observer。 */
export class CountingDuckdbProfileObserver implements DuckdbProfileObserver {
  private readonly counts = new Map<string, number>();

  observe(event: DuckdbProfileObservation): void {
    const key = [
      event.outcome,
      event.reason ?? 'none',
      event.failureCode ?? 'none',
      event.cacheHit ? 'hit' : 'miss',
    ].join(':');
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** 累積した件数を読み出す。返却値は呼び出し側で変更できない。 */
  snapshot(): Readonly<Record<string, number>> {
    return Object.freeze(Object.fromEntries(this.counts));
  }
}

/** 行数を低カーディナリティの観測値へ変換する。 */
export function duckdbProfileRowCountBucket(rowCount: number): DuckdbProfileRowCountBucket {
  if (rowCount <= 0) return '0';
  if (rowCount < 1_000) return '1-999';
  if (rowCount < 10_000) return '1000-9999';
  if (rowCount < 100_000) return '10000-99999';
  return '100000+';
}

/** production の structured log へ低カーディナリティ event を出す observer。 */
export function createConsoleDuckdbProfileObserver(
  log: (message: string, event: DuckdbProfileObservation) => void = (message, event) =>
    console.info(message, event),
): DuckdbProfileObserver {
  return {
    observe(event) {
      log('duckdb persisted profile observation', event);
    },
  };
}

/** observer の実装が request lifecycle を壊さないようにする安全な通知。 */
export function notifyDuckdbProfileObserver(
  observer: DuckdbProfileObserver | undefined,
  event: DuckdbProfileObservation,
): void {
  try {
    observer?.observe(event);
  } catch {
    // 観測系の失敗で結果 route の応答を変えない。
  }
}

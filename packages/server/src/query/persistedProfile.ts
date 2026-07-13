import type { ResultProfile } from '@hubble/contracts';
import type { ServerConfig } from '../config';
import type { HistoryResultRef } from '../store/history';
import {
  DuckdbProfileError,
  getDuckdbProfileEligibility,
  type DuckdbPersistedProfileReader,
  type DuckdbProfileEligibilityReason,
  type DuckdbProfileFailureCode,
  type DuckdbProfileInput,
} from '../resultStore';
import {
  duckdbProfileCapabilityKey,
  duckdbProfileObjectCapabilityKey,
  type DuckdbProfileNegativeCapabilityCache,
} from './duckdbProfileNegativeCache';
import {
  duckdbProfileRowCountBucket,
  notifyDuckdbProfileObserver,
  type DuckdbProfileObserver,
  type DuckdbProfileObservationReason,
} from './persistedProfileObservability';

/** 永続 profile の DuckDB 経路を適用できなかった理由。 */
export type PersistedProfileFallbackReason =
  | 'no_parquet'
  | 'non_s3'
  | 'reader_unavailable'
  | 'negative_cache'
  | DuckdbProfileEligibilityReason
  | DuckdbProfileFailureCode;

export type PersistedProfileAttempt =
  | { kind: 'success'; profile: ResultProfile }
  | {
      kind: 'fallback';
      reason: PersistedProfileFallbackReason;
      code?: DuckdbProfileFailureCode;
      completeJsonlFallback: (durationMs: number) => void;
    }
  | { kind: 'not_applicable'; reason: PersistedProfileFallbackReason };

function buildInput(
  ref: HistoryResultRef,
  config: ServerConfig,
  signal: AbortSignal | undefined,
): { input: DuckdbProfileInput } | { reason: PersistedProfileFallbackReason } {
  if (config.resultStore.kind !== 's3') return { reason: 'non_s3' };
  if (ref.parquetRef === undefined) return { reason: 'no_parquet' };
  if (ref.columns === undefined) return { reason: 'missing_columns' };
  const input: DuckdbProfileInput = {
    historyId: ref.id,
    objectKey: ref.parquetRef.objectKey,
    parquetExpiresAt: ref.parquetRef.expiresAt,
    rowCount: ref.rowCount,
    columns: ref.columns,
    bucket: config.resultStore.bucket,
    prefix: config.resultStore.prefix,
    region: config.resultStore.region,
    endpoint: config.resultStore.endpoint,
    encodingVersion: ref.parquetRef.encodingVersion,
    signal,
  };
  const eligibility = getDuckdbProfileEligibility(input);
  return eligibility.eligible ? { input } : { reason: eligibility.reason };
}

/**
 * 認可と結果期限確認後の Parquet profile 経路を選択する。
 * DuckDB の失敗だけを構造化して JSONL fallback へ渡し、abort は呼び出し元へ返す。
 */
export async function tryDuckdbPersistedProfile(input: {
  ref: HistoryResultRef;
  config: ServerConfig;
  reader: DuckdbPersistedProfileReader;
  signal?: AbortSignal;
  observer?: DuckdbProfileObserver;
  negativeCache?: DuckdbProfileNegativeCapabilityCache;
}): Promise<PersistedProfileAttempt> {
  const startedAt = Date.now();
  let queueWaitMs = 0;
  let duckdbDurationMs = 0;
  let jsonlFallbackObserved = false;
  const rowCountBucket = duckdbProfileRowCountBucket(input.ref.rowCount);
  const observe = (
    outcome: 'success' | 'not_applicable' | 'fallback' | 'aborted',
    reason?: DuckdbProfileObservationReason,
    failureCode?: DuckdbProfileFailureCode,
    cacheHit = false,
    jsonlFallbackDurationMs = 0,
  ): void => {
    notifyDuckdbProfileObserver(input.observer, {
      route: 'profile',
      outcome,
      reason,
      failureCode,
      totalDurationMs: Math.max(0, Date.now() - startedAt),
      queueWaitMs,
      duckdbDurationMs,
      jsonlFallbackDurationMs,
      rowCountBucket,
      cacheHit,
    });
  };
  const fallback = (
    reason: PersistedProfileFallbackReason,
    code?: DuckdbProfileFailureCode,
    cacheHit = false,
  ): PersistedProfileAttempt => {
    const eventReason = (cacheHit ? code : (code ?? reason)) as DuckdbProfileObservationReason;
    return {
      kind: 'fallback',
      reason,
      code,
      completeJsonlFallback: (durationMs) => {
        if (jsonlFallbackObserved) return;
        jsonlFallbackObserved = true;
        observe('fallback', eventReason, code, cacheHit, Math.max(0, durationMs));
      },
    };
  };
  if (!input.config.resultProfileDuckdbEnabled) {
    observe('not_applicable', 'disabled');
    return { kind: 'not_applicable', reason: 'disabled' };
  }
  const prepared = buildInput(input.ref, input.config, input.signal);
  if ('reason' in prepared) {
    observe('not_applicable', prepared.reason);
    return { kind: 'not_applicable', reason: prepared.reason };
  }
  const capabilityKey = duckdbProfileCapabilityKey(prepared.input);
  const objectCapabilityKey = duckdbProfileObjectCapabilityKey(prepared.input);
  const negativeCode =
    input.negativeCache?.get(capabilityKey) ?? input.negativeCache?.get(objectCapabilityKey);
  if (negativeCode !== undefined) {
    return fallback('negative_cache', negativeCode, true);
  }
  try {
    const readerStartedAt = Date.now();
    let timingObserved = false;
    const profile = await input.reader({
      ...prepared.input,
      timingObserver: (timing) => {
        timingObserved = true;
        queueWaitMs = Math.max(0, timing.queueWaitMs);
        duckdbDurationMs = Math.max(0, timing.duckdbDurationMs);
      },
    });
    if (!timingObserved) duckdbDurationMs = Math.max(0, Date.now() - readerStartedAt);
    if (profile === undefined) {
      return fallback('reader_unavailable');
    }
    observe('success');
    return { kind: 'success', profile };
  } catch (error) {
    if (!(error instanceof DuckdbProfileError)) {
      observe('fallback', 'duckdb_error', 'duckdb_error');
      throw error;
    }
    if (error.code === 'aborted') {
      observe('aborted', 'aborted', error.code);
      throw error;
    }
    if (error.code === 'auth' || error.code === 'httpfs') {
      input.negativeCache?.remember(capabilityKey, error.code);
    }
    if (error.code === 'schema_mismatch') {
      input.negativeCache?.remember(objectCapabilityKey, error.code);
    }
    return fallback(error.code, error.code);
  }
}

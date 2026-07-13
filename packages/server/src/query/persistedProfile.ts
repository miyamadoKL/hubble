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

/** 永続 profile の DuckDB 経路を適用できなかった理由。 */
export type PersistedProfileFallbackReason =
  | 'no_parquet'
  | 'non_s3'
  | 'reader_unavailable'
  | DuckdbProfileEligibilityReason
  | DuckdbProfileFailureCode;

export type PersistedProfileAttempt =
  | { kind: 'success'; profile: ResultProfile }
  | {
      kind: 'fallback';
      reason: PersistedProfileFallbackReason;
      code?: DuckdbProfileFailureCode;
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
}): Promise<PersistedProfileAttempt> {
  if (!input.config.resultProfileDuckdbEnabled) {
    return { kind: 'not_applicable', reason: 'disabled' };
  }
  const prepared = buildInput(input.ref, input.config, input.signal);
  if ('reason' in prepared) {
    return { kind: 'not_applicable', reason: prepared.reason };
  }
  try {
    const profile = await input.reader(prepared.input);
    if (profile === undefined) {
      return { kind: 'fallback', reason: 'reader_unavailable' };
    }
    return { kind: 'success', profile };
  } catch (error) {
    if (!(error instanceof DuckdbProfileError)) throw error;
    if (error.code === 'aborted') throw error;
    return { kind: 'fallback', reason: error.code, code: error.code };
  }
}

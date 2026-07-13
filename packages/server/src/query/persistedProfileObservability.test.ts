import { loadServerConfig } from '../config';
import { DuckdbProfileError } from '../resultStore';
import type { HistoryResultRef } from '../store/history';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryDuckdbProfileNegativeCapabilityCache,
  duckdbProfileCapabilityKey,
  duckdbProfileObjectCapabilityKey,
} from './duckdbProfileNegativeCache';
import { tryDuckdbPersistedProfile } from './persistedProfile';
import { CountingDuckdbProfileObserver } from './persistedProfileObservability';

function persistedRef(): HistoryResultRef {
  return {
    id: 'history-1',
    statement: 'SELECT 1',
    state: 'finished',
    rowCount: 1,
    elapsedMs: 1,
    datasourceId: 'trino-default',
    submittedAt: '2026-07-14T00:00:00.000Z',
    resultObjectKey: 'results/history-1.jsonl.zst',
    resultExpiresAt: '2099-01-01T00:00:00.000Z',
    parquetRef: {
      objectKey: 'results/history-1.parquet',
      expiresAt: '2099-01-01T00:00:00.000Z',
      encodingVersion: '1',
    },
    columns: [{ name: 'value', type: 'varchar' }],
    format: 'jsonl.zst',
  };
}

function config() {
  return loadServerConfig({
    RESULT_STORE: 's3',
    RESULT_STORE_S3_BUCKET: 'bucket',
    RESULT_STORE_S3_PREFIX: 'results/',
    RESULT_PROFILE_DUCKDB_ENABLED: 'true',
  });
}

describe('persisted profile observability and negative capability cache', () => {
  it('emits a bounded typed event for a direct reader result', async () => {
    const events: unknown[] = [];
    const attempt = await tryDuckdbPersistedProfile({
      ref: persistedRef(),
      config: config(),
      reader: vi.fn(async () => ({
        rowCount: 1,
        complete: true,
        columns: [
          {
            name: 'value',
            type: 'varchar',
            nullCount: 0,
            distinctCount: 1,
            distinctOverflow: false,
            topValues: [{ value: 'ok', count: 1 }],
          },
        ],
      })),
      observer: { observe: (event) => events.push(event) },
    });

    expect(attempt).toMatchObject({ kind: 'success' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      route: 'profile',
      outcome: 'success',
      totalDurationMs: expect.any(Number),
      queueWaitMs: 0,
      duckdbDurationMs: expect.any(Number),
      jsonlFallbackDurationMs: 0,
      rowCountBucket: '1-999',
      cacheHit: false,
    });
  });

  it('skips repeated auth failures until the capability cache expires', async () => {
    let now = 1_000;
    const cache = new InMemoryDuckdbProfileNegativeCapabilityCache(100, 8, () => now);
    const observer = new CountingDuckdbProfileObserver();
    const reader = vi.fn(async () => {
      throw new DuckdbProfileError('auth', 'credential chain failed');
    });

    const first = await tryDuckdbPersistedProfile({
      ref: persistedRef(),
      config: config(),
      reader,
      negativeCache: cache,
      observer,
    });
    const second = await tryDuckdbPersistedProfile({
      ref: persistedRef(),
      config: config(),
      reader,
      negativeCache: cache,
      observer,
    });

    expect(first).toMatchObject({ kind: 'fallback', reason: 'auth' });
    expect(second).toMatchObject({ kind: 'fallback', reason: 'negative_cache', code: 'auth' });
    if (first.kind !== 'fallback' || second.kind !== 'fallback')
      throw new Error('fallback expected');
    first.completeJsonlFallback(4);
    second.completeJsonlFallback(5);
    expect(reader).toHaveBeenCalledOnce();
    expect(observer.snapshot()).toMatchObject({
      'fallback:auth:auth:miss': 1,
      'fallback:auth:auth:hit': 1,
    });

    now = 1_101;
    await tryDuckdbPersistedProfile({
      ref: persistedRef(),
      config: config(),
      reader,
      negativeCache: cache,
      observer,
    });
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('caches schema mismatch by hashed object key with a short TTL', async () => {
    let now = 1_000;
    const cache = new InMemoryDuckdbProfileNegativeCapabilityCache(60_000, 8, () => now, 10);
    const observer = new CountingDuckdbProfileObserver();
    const reader = vi.fn(async () => {
      throw new DuckdbProfileError('schema_mismatch', 'schema differs');
    });

    const first = await tryDuckdbPersistedProfile({
      ref: persistedRef(),
      config: config(),
      reader,
      negativeCache: cache,
      observer,
    });
    const second = await tryDuckdbPersistedProfile({
      ref: persistedRef(),
      config: config(),
      reader,
      negativeCache: cache,
      observer,
    });

    expect(first).toMatchObject({ kind: 'fallback', reason: 'schema_mismatch' });
    expect(second).toMatchObject({
      kind: 'fallback',
      reason: 'negative_cache',
      code: 'schema_mismatch',
    });
    if (first.kind !== 'fallback' || second.kind !== 'fallback')
      throw new Error('fallback expected');
    first.completeJsonlFallback(2);
    second.completeJsonlFallback(3);
    expect(reader).toHaveBeenCalledOnce();
    expect(observer.snapshot()).toMatchObject({
      'fallback:schema_mismatch:schema_mismatch:miss': 1,
      'fallback:schema_mismatch:schema_mismatch:hit': 1,
    });

    now = 1_011;
    const third = await tryDuckdbPersistedProfile({
      ref: persistedRef(),
      config: config(),
      reader,
      negativeCache: cache,
    });
    expect(third).toMatchObject({ kind: 'fallback', reason: 'schema_mismatch' });
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('does not cache timeout or abort failures', async () => {
    const cache = new InMemoryDuckdbProfileNegativeCapabilityCache();
    const reader = vi
      .fn()
      .mockRejectedValueOnce(new DuckdbProfileError('timeout', 'timed out'))
      .mockRejectedValueOnce(new DuckdbProfileError('timeout', 'timed out'));

    const first = await tryDuckdbPersistedProfile({
      ref: persistedRef(),
      config: config(),
      reader,
      negativeCache: cache,
    });
    const second = await tryDuckdbPersistedProfile({
      ref: persistedRef(),
      config: config(),
      reader,
      negativeCache: cache,
    });

    if (first.kind !== 'fallback' || second.kind !== 'fallback')
      throw new Error('fallback expected');
    first.completeJsonlFallback(1);
    second.completeJsonlFallback(1);
    expect(reader).toHaveBeenCalledTimes(2);
  });

  it('uses a capability key without the object key or credentials', () => {
    const input = {
      historyId: 'history-1',
      objectKey: 'results/history-1.parquet',
      parquetExpiresAt: '2099-01-01T00:00:00.000Z',
      rowCount: 1,
      columns: [{ name: 'value', type: 'varchar' }],
      bucket: 'bucket',
      prefix: 'results/',
      region: 'us-east-1',
      encodingVersion: '1',
    };
    const key = duckdbProfileCapabilityKey(input);
    expect(key).toContain('bucket');
    expect(key).toContain('results/');
    expect(key).not.toContain('history-1.parquet');
    expect(key).not.toContain('AWS_ACCESS_KEY_ID');

    const objectKey = duckdbProfileObjectCapabilityKey(input);
    expect(objectKey).toMatch(/^object:[0-9a-f]{24}$/);
    expect(objectKey).not.toContain('history-1.parquet');
  });
});

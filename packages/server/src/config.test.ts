import { describe, expect, it } from 'vitest';
import { loadServerConfig } from './config';

describe('loadServerConfig integer bounds', () => {
  it('rejects QUERY_CONCURRENCY=0', () => {
    expect(() => loadServerConfig({ QUERY_CONCURRENCY: '0' })).toThrow(/minimum: 1/);
  });

  it('rejects negative QUERY_CONCURRENCY', () => {
    expect(() => loadServerConfig({ QUERY_CONCURRENCY: '-1' })).toThrow(/minimum: 1/);
  });

  it('rejects negative QUERY_MAX_ROWS', () => {
    expect(() => loadServerConfig({ QUERY_MAX_ROWS: '-100' })).toThrow(/minimum: 1/);
  });

  it('accepts QUERY_GUARD_MAX_SCAN_BYTES=0', () => {
    const config = loadServerConfig({ QUERY_GUARD_MAX_SCAN_BYTES: '0' });
    expect(config.guard.maxScanBytes).toBe(0);
  });

  it('rejects negative QUERY_GUARD_MAX_SCAN_BYTES', () => {
    expect(() => loadServerConfig({ QUERY_GUARD_MAX_SCAN_BYTES: '-1' })).toThrow(/minimum: 0/);
  });

  it('defaults ResultStore to none with a 7 day TTL', () => {
    expect(loadServerConfig({}).resultStore).toEqual({ kind: 'none', ttlDays: 7 });
  });

  it('requires an S3 bucket when ResultStore is s3', () => {
    expect(() => loadServerConfig({ RESULT_STORE: 's3' })).toThrow(/RESULT_STORE_S3_BUCKET/);
  });

  it('loads S3 ResultStore settings from env', () => {
    expect(
      loadServerConfig({
        RESULT_STORE: 's3',
        RESULT_STORE_S3_BUCKET: 'bucket',
        RESULT_STORE_S3_PREFIX: 'prefix/',
        RESULT_STORE_S3_REGION: 'us-east-1',
        RESULT_STORE_S3_ENDPOINT: 'http://localhost:9000',
        RESULT_STORE_TTL_DAYS: '30',
      }).resultStore,
    ).toEqual({
      kind: 's3',
      bucket: 'bucket',
      prefix: 'prefix/',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      ttlDays: 30,
    });
  });
});

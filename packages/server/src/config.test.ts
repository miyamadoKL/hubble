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
});

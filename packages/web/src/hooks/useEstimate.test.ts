import { describe, it, expect } from 'vitest';
import { estimateQueryKey, ESTIMATE_STALE_MS } from './useEstimate';

describe('estimateQueryKey', () => {
  it('keys by resolved statement + context so identical inputs dedupe', () => {
    const a = estimateQueryKey({ statement: 'SELECT 1', catalog: 'tpch', schema: 'tiny' });
    const b = estimateQueryKey({ statement: 'SELECT 1', catalog: 'tpch', schema: 'tiny' });
    expect(a).toEqual(b);
  });

  it('differs when the statement or context differs', () => {
    const base = { statement: 'SELECT 1', catalog: 'tpch', schema: 'tiny' };
    expect(estimateQueryKey(base)).not.toEqual(
      estimateQueryKey({ ...base, statement: 'SELECT 2' }),
    );
    expect(estimateQueryKey(base)).not.toEqual(estimateQueryKey({ ...base, schema: 'sf1' }));
  });

  it('includes datasourceId in the key', () => {
    const key = estimateQueryKey({
      statement: 'SELECT 1',
      catalog: 'tpch',
      schema: 'tiny',
      datasourceId: 'trino-default',
    });
    expect(key).toEqual(['estimate', 'trino-default', 'tpch', 'tiny', 'SELECT 1']);
  });

  it('carries a null statement (the disabled sentinel) in the key', () => {
    const key = estimateQueryKey({ statement: null });
    expect(key[4]).toBeNull();
  });

  it('mirrors the server cache window', () => {
    expect(ESTIMATE_STALE_MS).toBe(30_000);
  });
});

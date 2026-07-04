import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { effectiveMaxRows, validateSessionProperties } from './queryRequest';

describe('effectiveMaxRows', () => {
  it('returns undefined when request omits maxRows', () => {
    expect(effectiveMaxRows(undefined, 100_000)).toBeUndefined();
  });

  it('clamps request exceeding server limit', () => {
    expect(effectiveMaxRows(500_000, 100_000)).toBe(100_000);
  });

  it('passes through request within server limit', () => {
    expect(effectiveMaxRows(10, 100_000)).toBe(10);
  });
});

describe('validateSessionProperties', () => {
  it('accepts valid keys and values', () => {
    expect(validateSessionProperties({ query_max_run_time: '5m' })).toEqual({
      query_max_run_time: '5m',
    });
  });

  it('rejects invalid keys', () => {
    expect(() => validateSessionProperties({ 'bad=key': 'x' })).toThrow(AppError);
    expect(() => validateSessionProperties({ 'bad,key': 'x' })).toThrow(AppError);
  });

  it('rejects values containing newlines', () => {
    expect(() => validateSessionProperties({ query_max_run_time: '5m\ninjected' })).toThrow(
      AppError,
    );
  });
});

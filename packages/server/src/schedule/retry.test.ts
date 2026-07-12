import { describe, expect, it } from 'vitest';
import { AppError, TrinoQueryError, TrinoTransportError } from '../errors';
import { defaultRetryPolicy, retryPolicySchema } from '@hubble/contracts';
import {
  backoffMs,
  classifyFailure,
  MAX_TIMER_DELAY_MS,
  retryPolicyForStatement,
  shouldRetry,
} from './retry';

function userError(): TrinoQueryError {
  return new TrinoQueryError({ message: 'bad sql', errorType: 'USER_ERROR' });
}
function engineError(): TrinoQueryError {
  return new TrinoQueryError({ message: 'engine fault', errorType: 'INTERNAL_ERROR' });
}

describe('failure classification', () => {
  it('treats Trino USER_ERROR as deterministic (no retry)', () => {
    expect(classifyFailure(userError())).toBe('deterministic');
  });

  it('treats a Query Guard block as deterministic', () => {
    const blocked = AppError.queryBlocked('blocked', { reasons: [] });
    expect(classifyFailure(blocked)).toBe('deterministic');
  });

  it('treats transport faults as transient', () => {
    expect(classifyFailure(new TrinoTransportError('down'))).toBe('transient');
  });

  it('treats non-USER_ERROR Trino failures as transient', () => {
    expect(classifyFailure(engineError())).toBe('transient');
  });

  it('treats unknown errors as transient', () => {
    expect(classifyFailure(new Error('???'))).toBe('transient');
  });
});

describe('statement retry safety', () => {
  const configured = retryPolicySchema.parse({
    maxAttempts: 5,
    backoffSeconds: 10,
    backoffMultiplier: 2,
  });

  it('keeps the configured retry policy for read statements', () => {
    expect(retryPolicyForStatement(configured, 'SELECT * FROM orders')).toBe(configured);
  });

  it('limits write and unclassified statements to one attempt', () => {
    expect(retryPolicyForStatement(configured, 'INSERT INTO audit VALUES (1)').maxAttempts).toBe(1);
    expect(
      retryPolicyForStatement(configured, 'WITH source AS (SELECT 1) SELECT * FROM source')
        .maxAttempts,
    ).toBe(1);
  });
});

describe('backoff', () => {
  const policy = retryPolicySchema.parse({
    maxAttempts: 4,
    backoffSeconds: 60,
    backoffMultiplier: 2,
  });

  it('grows geometrically per retry index', () => {
    expect(backoffMs(policy, 1)).toBe(60_000); // 60 * 2^0
    expect(backoffMs(policy, 2)).toBe(120_000); // 60 * 2^1
    expect(backoffMs(policy, 3)).toBe(240_000); // 60 * 2^2
  });

  it('uses the default policy values', () => {
    expect(defaultRetryPolicy).toEqual({
      maxAttempts: 3,
      backoffSeconds: 60,
      backoffMultiplier: 2,
    });
    expect(backoffMs(defaultRetryPolicy, 1)).toBe(60_000);
  });

  it('Node.jsの安全範囲を超える待機時間を最大値へ制限する', () => {
    const large = retryPolicySchema.parse({
      maxAttempts: 10,
      backoffSeconds: 3_600,
      backoffMultiplier: 10,
    });

    expect(backoffMs(large, 4)).toBe(MAX_TIMER_DELAY_MS);
  });
});

describe('shouldRetry', () => {
  const policy = retryPolicySchema.parse({ maxAttempts: 3 });

  it('allows retries until maxAttempts is reached', () => {
    expect(shouldRetry(policy, 1)).toBe(true);
    expect(shouldRetry(policy, 2)).toBe(true);
    expect(shouldRetry(policy, 3)).toBe(false);
  });

  it('disables retries when maxAttempts is 1', () => {
    const once = retryPolicySchema.parse({ maxAttempts: 1 });
    expect(shouldRetry(once, 1)).toBe(false);
  });
});

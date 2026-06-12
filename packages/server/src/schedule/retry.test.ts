import { describe, expect, it } from 'vitest';
import { AppError, TrinoQueryError, TrinoTransportError } from '../errors';
import { defaultRetryPolicy, retryPolicySchema } from '@hubble/contracts';
import { backoffMs, classifyFailure, shouldRetry } from './retry';

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

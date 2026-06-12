import { describe, it, expect } from 'vitest';
import { UNAUTHENTICATED } from '@hubble/contracts';
import { ApiClientError } from '../api/client';
import { isUnauthenticated } from './useMe';

describe('isUnauthenticated', () => {
  it('is true for a 401 UNAUTHENTICATED ApiClientError', () => {
    const err = new ApiClientError(401, { code: UNAUTHENTICATED, message: 'no session' });
    expect(isUnauthenticated(err)).toBe(true);
  });

  it('is false for other API errors', () => {
    expect(isUnauthenticated(new ApiClientError(404, { code: 'NOT_FOUND', message: 'x' }))).toBe(
      false,
    );
    expect(isUnauthenticated(new ApiClientError(500, { code: 'INTERNAL', message: 'x' }))).toBe(
      false,
    );
  });

  it('is false for non-ApiClientError values', () => {
    expect(isUnauthenticated(new Error('boom'))).toBe(false);
    expect(isUnauthenticated(undefined)).toBe(false);
    expect(isUnauthenticated(null)).toBe(false);
  });
});

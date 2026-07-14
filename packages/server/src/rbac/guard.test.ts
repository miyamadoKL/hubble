import { describe, expect, it } from 'vitest';
import type { ServerConfig } from '../config';
import { effectiveGuardLimits } from './guard';

const baseGuard: ServerConfig['guard'] = {
  mode: 'warn',
  maxScanBytes: 1_000_000,
  maxScanRows: 10_000,
  onUnknown: 'warn',
  estimateTimeoutMs: 3000,
  cacheTtlSeconds: 30,
  bytesPerSecond: 0,
};

describe('effectiveGuardLimits', () => {
  it('merges role guard overrides shallowly', () => {
    const effective = effectiveGuardLimits(baseGuard, {
      name: 'member',
      permissions: new Set(),
      datasources: ['*'],
      guard: { maxScanBytes: 1000, onUnknown: 'block' },
    });
    expect(effective).toEqual({
      mode: 'warn',
      maxScanBytes: 1000,
      maxScanRows: 10_000,
      onUnknown: 'block',
    });
  });
});

import { describe, it, expect } from 'vitest';
import { computeVerdict, type GuardLimits, type VerdictInput } from './guardVerdict';

function limits(over: Partial<GuardLimits> = {}): GuardLimits {
  return {
    mode: 'enforce',
    maxScanBytes: 0,
    maxScanRows: 0,
    onUnknown: 'warn',
    ...over,
  };
}

function estimated(over: Partial<VerdictInput> = {}): VerdictInput {
  const scanBytes = over.scanBytes ?? null;
  const scanRows = over.scanRows ?? null;
  return {
    status: 'estimated',
    scanBytes,
    scanBytesComplete: scanBytes !== null,
    scanRows,
    scanRowsComplete: scanRows !== null,
    ...over,
  };
}

describe('computeVerdict — status short-circuits', () => {
  it('always allows unsupported regardless of mode', () => {
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      const v = computeVerdict(
        estimated({ status: 'unsupported' }),
        limits({ mode, onUnknown: 'block', maxScanRows: 1 }),
      );
      expect(v.decision).toBe('allow');
      expect(v.reasons).toEqual([]);
    }
  });

  it('always allows disabled', () => {
    const v = computeVerdict(
      estimated({ status: 'disabled' }),
      limits({ mode: 'enforce', onUnknown: 'block' }),
    );
    expect(v.decision).toBe('allow');
  });
});

describe('computeVerdict — estimated, within limits', () => {
  it('allows when both estimates are under the limits', () => {
    const v = computeVerdict(
      estimated({ scanBytes: 1000, scanRows: 10 }),
      limits({ maxScanBytes: 10_000, maxScanRows: 1000 }),
    );
    expect(v.decision).toBe('allow');
    expect(v.reasons).toEqual([]);
  });

  it('allows when no limits are configured (limit 0 = unlimited)', () => {
    const v = computeVerdict(
      estimated({ scanBytes: 9e18, scanRows: 9e18 }),
      limits({ maxScanBytes: 0, maxScanRows: 0 }),
    );
    expect(v.decision).toBe('allow');
  });
});

describe('computeVerdict — estimated, exceeding limits', () => {
  it('blocks in enforce mode when scanRows exceeds the limit', () => {
    const v = computeVerdict(
      estimated({ scanRows: 6_001_215 }),
      limits({ mode: 'enforce', maxScanRows: 1_000_000 }),
    );
    expect(v.decision).toBe('block');
    expect(v.reasons[0]).toContain('6,001,215');
    expect(v.reasons[0]).toContain('1,000,000');
  });

  it('warns (never blocks) in warn mode when a limit is exceeded', () => {
    const v = computeVerdict(
      estimated({ scanBytes: 2000 }),
      limits({ mode: 'warn', maxScanBytes: 1000 }),
    );
    expect(v.decision).toBe('warn');
    expect(v.reasons).toHaveLength(1);
  });

  it('reports both byte and row violations', () => {
    const v = computeVerdict(
      estimated({ scanBytes: 5000, scanRows: 5000 }),
      limits({ mode: 'enforce', maxScanBytes: 1000, maxScanRows: 1000 }),
    );
    expect(v.decision).toBe('block');
    expect(v.reasons).toHaveLength(2);
  });

  it('reports a known violation and the other incomplete dimension', () => {
    // bytes の既知小計が上限を超え、rows は不完全なので両方の理由を報告する。
    const v = computeVerdict(
      estimated({ scanBytes: 5000 }),
      limits({ mode: 'enforce', maxScanBytes: 1000, maxScanRows: 1000 }),
    );
    expect(v.decision).toBe('block');
    expect(v.reasons).toHaveLength(2);
    expect(v.reasons[0]).toContain('bytes');
    expect(v.reasons[1]).toContain('rows');
  });

  it('allows an unknown dimension when onUnknown=allow', () => {
    const v = computeVerdict(
      estimated({ scanRows: 10 }),
      limits({ mode: 'enforce', maxScanBytes: 1000, maxScanRows: 1000, onUnknown: 'allow' }),
    );
    expect(v.decision).toBe('allow');
  });
});

describe('computeVerdict — partially estimated JOIN', () => {
  const partialJoin = estimated({
    scanBytes: 1000,
    scanBytesComplete: false,
    scanRows: 10,
    scanRowsComplete: true,
  });

  it.each([
    ['allow', 'allow'],
    ['warn', 'warn'],
    ['block', 'block'],
  ] as const)('applies onUnknown=%s to an incomplete limited dimension', (onUnknown, decision) => {
    const verdict = computeVerdict(
      partialJoin,
      limits({ mode: 'enforce', maxScanBytes: 10_000, maxScanRows: 100, onUnknown }),
    );
    expect(verdict.decision).toBe(decision);
  });

  it('ignores incompleteness for a dimension without a configured limit', () => {
    const verdict = computeVerdict(
      partialJoin,
      limits({ mode: 'enforce', maxScanBytes: 0, maxScanRows: 100, onUnknown: 'block' }),
    );
    expect(verdict.decision).toBe('allow');
  });
});

describe('computeVerdict — estimated, both unknown (ON_UNKNOWN)', () => {
  const bothUnknown = estimated();

  it('allows when onUnknown=allow', () => {
    const v = computeVerdict(bothUnknown, limits({ onUnknown: 'allow', maxScanRows: 1000 }));
    expect(v.decision).toBe('allow');
    expect(v.reasons).toEqual([]);
  });

  it('warns when onUnknown=warn (any mode)', () => {
    const v = computeVerdict(bothUnknown, limits({ onUnknown: 'warn', maxScanRows: 1000 }));
    expect(v.decision).toBe('warn');
    expect(v.reasons).toHaveLength(1);
  });

  it('blocks when onUnknown=block in enforce mode', () => {
    const v = computeVerdict(
      bothUnknown,
      limits({ mode: 'enforce', onUnknown: 'block', maxScanRows: 1000 }),
    );
    expect(v.decision).toBe('block');
  });

  it('downgrades onUnknown=block to warn in warn mode', () => {
    const v = computeVerdict(
      bothUnknown,
      limits({ mode: 'warn', onUnknown: 'block', maxScanRows: 1000 }),
    );
    expect(v.decision).toBe('warn');
  });

  it('allows both-unknown when no limit is set, even with onUnknown=block', () => {
    // No limit configured -> nothing to enforce -> the unknown is moot.
    const v = computeVerdict(
      bothUnknown,
      limits({ mode: 'enforce', onUnknown: 'block', maxScanBytes: 0, maxScanRows: 0 }),
    );
    expect(v.decision).toBe('allow');
  });
});

describe('computeVerdict — unavailable (ON_UNKNOWN)', () => {
  const unavailable = estimated({ status: 'unavailable' });

  it('allows when onUnknown=allow', () => {
    expect(computeVerdict(unavailable, limits({ onUnknown: 'allow' })).decision).toBe('allow');
  });

  it('blocks in enforce when onUnknown=block', () => {
    expect(
      computeVerdict(
        unavailable,
        limits({ mode: 'enforce', onUnknown: 'block', maxScanRows: 1000 }),
      ).decision,
    ).toBe('block');
  });

  it('downgrades to warn in warn mode when onUnknown=block', () => {
    expect(
      computeVerdict(unavailable, limits({ mode: 'warn', onUnknown: 'block', maxScanRows: 1000 }))
        .decision,
    ).toBe('warn');
  });

  it('allows unavailable when no limit is set, even with onUnknown=block', () => {
    // No limit configured -> nothing to protect -> the unknown is moot
    // (consistent with the both-unknown 'estimated' case above).
    const v = computeVerdict(unavailable, limits({ mode: 'enforce', onUnknown: 'block' }));
    expect(v.decision).toBe('allow');
    expect(v.reasons).toEqual([]);
  });
});

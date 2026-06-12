import { describe, it, expect } from 'vitest';
import { computeVerdict, type GuardLimits } from './guardVerdict';

function limits(over: Partial<GuardLimits> = {}): GuardLimits {
  return {
    mode: 'enforce',
    maxScanBytes: 0,
    maxScanRows: 0,
    onUnknown: 'warn',
    ...over,
  };
}

describe('computeVerdict — status short-circuits', () => {
  it('always allows unsupported regardless of mode', () => {
    for (const mode of ['off', 'warn', 'enforce'] as const) {
      const v = computeVerdict(
        { status: 'unsupported', scanBytes: null, scanRows: null },
        limits({ mode, onUnknown: 'block', maxScanRows: 1 }),
      );
      expect(v.decision).toBe('allow');
      expect(v.reasons).toEqual([]);
    }
  });

  it('always allows disabled', () => {
    const v = computeVerdict(
      { status: 'disabled', scanBytes: null, scanRows: null },
      limits({ mode: 'enforce', onUnknown: 'block' }),
    );
    expect(v.decision).toBe('allow');
  });
});

describe('computeVerdict — estimated, within limits', () => {
  it('allows when both estimates are under the limits', () => {
    const v = computeVerdict(
      { status: 'estimated', scanBytes: 1000, scanRows: 10 },
      limits({ maxScanBytes: 10_000, maxScanRows: 1000 }),
    );
    expect(v.decision).toBe('allow');
    expect(v.reasons).toEqual([]);
  });

  it('allows when no limits are configured (limit 0 = unlimited)', () => {
    const v = computeVerdict(
      { status: 'estimated', scanBytes: 9e18, scanRows: 9e18 },
      limits({ maxScanBytes: 0, maxScanRows: 0 }),
    );
    expect(v.decision).toBe('allow');
  });
});

describe('computeVerdict — estimated, exceeding limits', () => {
  it('blocks in enforce mode when scanRows exceeds the limit', () => {
    const v = computeVerdict(
      { status: 'estimated', scanBytes: null, scanRows: 6_001_215 },
      limits({ mode: 'enforce', maxScanRows: 1_000_000 }),
    );
    expect(v.decision).toBe('block');
    expect(v.reasons[0]).toContain('6,001,215');
    expect(v.reasons[0]).toContain('1,000,000');
  });

  it('warns (never blocks) in warn mode when a limit is exceeded', () => {
    const v = computeVerdict(
      { status: 'estimated', scanBytes: 2000, scanRows: null },
      limits({ mode: 'warn', maxScanBytes: 1000 }),
    );
    expect(v.decision).toBe('warn');
    expect(v.reasons).toHaveLength(1);
  });

  it('reports both byte and row violations', () => {
    const v = computeVerdict(
      { status: 'estimated', scanBytes: 5000, scanRows: 5000 },
      limits({ mode: 'enforce', maxScanBytes: 1000, maxScanRows: 1000 }),
    );
    expect(v.decision).toBe('block');
    expect(v.reasons).toHaveLength(2);
  });

  it('judges on the known estimate when only one is available', () => {
    // bytes known and over limit, rows unknown -> still a violation.
    const v = computeVerdict(
      { status: 'estimated', scanBytes: 5000, scanRows: null },
      limits({ mode: 'enforce', maxScanBytes: 1000, maxScanRows: 1000 }),
    );
    expect(v.decision).toBe('block');
    expect(v.reasons).toHaveLength(1);
    expect(v.reasons[0]).toContain('bytes');
  });

  it('allows when the only known estimate is under its limit and the other is unknown', () => {
    // rows known & under limit, bytes unknown -> not both unknown, so no
    // ON_UNKNOWN; judged on the known (passing) estimate -> allow.
    const v = computeVerdict(
      { status: 'estimated', scanBytes: null, scanRows: 10 },
      limits({ mode: 'enforce', maxScanBytes: 1000, maxScanRows: 1000 }),
    );
    expect(v.decision).toBe('allow');
  });
});

describe('computeVerdict — estimated, both unknown (ON_UNKNOWN)', () => {
  const bothUnknown = { status: 'estimated', scanBytes: null, scanRows: null } as const;

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
  const unavailable = { status: 'unavailable', scanBytes: null, scanRows: null } as const;

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

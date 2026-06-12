import { describe, it, expect } from 'vitest';
import type { ApiErrorDetail, EstimateResult } from '@hubble/contracts';
import {
  computeLiveEstimateTarget,
  estimatePresentation,
  parseQueryBlocked,
  resolveEstimateInput,
} from './estimate';
import { withAutoLimit } from './sql';

/** A minimal estimated result, overridable per test. */
function estimated(over: Partial<EstimateResult> = {}): EstimateResult {
  return {
    status: 'estimated',
    scanBytes: 1000,
    scanRows: 10,
    outputRows: 10,
    outputBytes: 1000,
    estimatedSeconds: null,
    tables: [],
    verdict: { decision: 'allow', reasons: [] },
    elapsedMs: 5,
    ...over,
  };
}

describe('resolveEstimateInput — run-identical statement', () => {
  it('applies variable substitution then auto-LIMIT (same as the run path)', () => {
    const res = resolveEstimateInput({
      unitText: 'SELECT * FROM ${tbl}',
      variableValues: { tbl: 'nation' },
      autoLimit: true,
      limit: 5000,
    });
    expect(res.ok).toBe(true);
    // Byte-identical to what executionStore.runUnit would send.
    const expected = withAutoLimit('SELECT * FROM nation', 5000).sql;
    expect(res.ok && res.statement).toBe(expected);
    expect(res.ok && res.statement).toContain('LIMIT 5000');
  });

  it('does not append LIMIT when auto-LIMIT is off', () => {
    const res = resolveEstimateInput({
      unitText: 'SELECT * FROM nation',
      variableValues: {},
      autoLimit: false,
      limit: 5000,
    });
    expect(res.ok && res.statement).toBe('SELECT * FROM nation');
  });

  it('skips when a variable is unresolved (the run would be blocked too)', () => {
    const res = resolveEstimateInput({
      unitText: 'SELECT * FROM ${missing}',
      variableValues: {},
      autoLimit: true,
      limit: 5000,
    });
    expect(res).toEqual({ ok: false, reason: 'missing-variables' });
  });

  it('skips an empty unit', () => {
    const res = resolveEstimateInput({
      unitText: '   ',
      variableValues: {},
      autoLimit: true,
      limit: 5000,
    });
    expect(res).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('computeLiveEstimateTarget — estimate only when it parses', () => {
  const base = {
    variableValues: {},
    autoLimit: true,
    limit: 5000,
    guardMode: 'enforce' as const,
    parsesClean: () => true,
  };
  const caretAtEnd = (sql: string) => ({ anchor: sql.length, active: sql.length });

  it('returns a statement when the unit parses clean', () => {
    const source = 'SELECT * FROM nation';
    const target = computeLiveEstimateTarget({
      ...base,
      source,
      selection: caretAtEnd(source),
    });
    expect(target.estimate).toBe(true);
    expect(target.estimate && target.statement).toContain('SELECT * FROM nation');
    expect(target.estimate && target.statement).toContain('LIMIT 5000');
  });

  it('skips when the parser reports an error (mid-edit / syntax error)', () => {
    const source = 'SELECT * FRM nation';
    const target = computeLiveEstimateTarget({
      ...base,
      source,
      selection: caretAtEnd(source),
      parsesClean: () => false,
    });
    expect(target).toEqual({ estimate: false, reason: 'parse-error' });
  });

  it('never calls the API when the guard is off', () => {
    const source = 'SELECT * FROM nation';
    let parseCalled = false;
    const target = computeLiveEstimateTarget({
      ...base,
      guardMode: 'off',
      source,
      selection: caretAtEnd(source),
      parsesClean: () => {
        parseCalled = true;
        return true;
      },
    });
    expect(target).toEqual({ estimate: false, reason: 'guard-off' });
    expect(parseCalled).toBe(false);
  });

  it('skips an empty cell', () => {
    const target = computeLiveEstimateTarget({ ...base, source: '', selection: caretAtEnd('') });
    expect(target).toEqual({ estimate: false, reason: 'empty' });
  });

  it('skips when a variable is unresolved', () => {
    const source = 'SELECT * FROM ${missing}';
    const target = computeLiveEstimateTarget({
      ...base,
      source,
      selection: caretAtEnd(source),
    });
    expect(target).toEqual({ estimate: false, reason: 'missing-variables' });
  });

  it('estimates the selected text when there is a selection', () => {
    const source = 'SELECT 1;\nSELECT * FROM nation';
    // Select only the second statement.
    const start = source.indexOf('SELECT * FROM nation');
    const target = computeLiveEstimateTarget({
      ...base,
      source,
      selection: { anchor: start, active: source.length },
    });
    expect(target.estimate).toBe(true);
    expect(target.estimate && target.statement).toContain('FROM nation');
    expect(target.estimate && target.statement).not.toContain('SELECT 1');
  });
});

describe('estimatePresentation — verdict → UI state', () => {
  it('hides for disabled / unsupported statuses', () => {
    expect(estimatePresentation(estimated({ status: 'disabled' })).visible).toBe(false);
    expect(estimatePresentation(estimated({ status: 'unsupported' })).visible).toBe(false);
  });

  it('shows an info tone for allow', () => {
    const p = estimatePresentation(estimated({ verdict: { decision: 'allow', reasons: [] } }));
    expect(p).toMatchObject({ visible: true, tone: 'info', blocked: false });
    expect(p.scanRows).toBe(10);
    expect(p.scanBytes).toBe(1000);
  });

  it('shows a warning tone + reasons for warn', () => {
    const p = estimatePresentation(
      estimated({ verdict: { decision: 'warn', reasons: ['Large scan'] } }),
    );
    expect(p).toMatchObject({ visible: true, tone: 'warning', blocked: false });
    expect(p.reasons).toEqual(['Large scan']);
  });

  it('shows an error tone + blocked for block', () => {
    const p = estimatePresentation(
      estimated({
        scanRows: 6_001_215,
        scanBytes: 783_988_912,
        verdict: { decision: 'block', reasons: ['Exceeds the limit'] },
      }),
    );
    expect(p).toMatchObject({ visible: true, tone: 'error', blocked: true });
    expect(p.scanRows).toBe(6_001_215);
    expect(p.reasons).toEqual(['Exceeds the limit']);
  });

  it('surfaces the time estimate only when non-null', () => {
    expect(estimatePresentation(estimated({ estimatedSeconds: null })).estimatedSeconds).toBeNull();
    expect(estimatePresentation(estimated({ estimatedSeconds: 7.8 })).estimatedSeconds).toBe(7.8);
  });

  it('renders unavailable as a muted notice, escalated by the verdict', () => {
    const allow = estimatePresentation(
      estimated({ status: 'unavailable', scanRows: null, scanBytes: null }),
    );
    expect(allow).toMatchObject({ visible: true, tone: 'unavailable', blocked: false });
    expect(allow.label).toBe('estimate unavailable');

    const blocked = estimatePresentation(
      estimated({
        status: 'unavailable',
        scanRows: null,
        scanBytes: null,
        verdict: { decision: 'block', reasons: ['Could not estimate'] },
      }),
    );
    expect(blocked).toMatchObject({ tone: 'error', blocked: true });
  });
});

describe('parseQueryBlocked — 422 details', () => {
  const estimate = estimated({
    scanRows: 6_001_215,
    scanBytes: 783_988_912,
    verdict: { decision: 'block', reasons: ['Estimated scan of 6,001,215 rows exceeds the limit'] },
  });

  it('extracts the typed { estimate, limits } payload', () => {
    const err: ApiErrorDetail = {
      code: 'QUERY_BLOCKED',
      message: 'Query blocked by Query Guard',
      details: {
        estimate,
        limits: { mode: 'enforce', maxScanBytes: 0, maxScanRows: 1_000_000, onUnknown: 'warn' },
      },
    };
    const parsed = parseQueryBlocked(err);
    expect(parsed).toBeDefined();
    expect(parsed!.estimate.scanRows).toBe(6_001_215);
    expect(parsed!.limits.maxScanRows).toBe(1_000_000);
    // The block snapshot omits bytesPerSecond — it defaults to 0.
    expect(parsed!.limits.bytesPerSecond).toBe(0);
  });

  it('returns undefined for a non-QUERY_BLOCKED error', () => {
    expect(parseQueryBlocked({ code: 'EXECUTION_ERROR', message: 'boom' })).toBeUndefined();
  });

  it('returns undefined when details are missing or malformed', () => {
    expect(parseQueryBlocked({ code: 'QUERY_BLOCKED', message: 'x' })).toBeUndefined();
    expect(
      parseQueryBlocked({ code: 'QUERY_BLOCKED', message: 'x', details: { estimate: 42 } }),
    ).toBeUndefined();
  });
});

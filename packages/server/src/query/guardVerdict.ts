import type {
  EstimateStatus,
  GuardDecision,
  GuardMode,
  GuardOnUnknown,
  GuardVerdict,
} from '@hubble/contracts';

/** Limits + policy the verdict is computed against (Query Guard feature). */
export interface GuardLimits {
  mode: GuardMode;
  /** Scan-bytes limit (0 = no limit). */
  maxScanBytes: number;
  /** Scan-rows limit (0 = no limit). */
  maxScanRows: number;
  onUnknown: GuardOnUnknown;
}

export interface VerdictInput {
  status: EstimateStatus;
  /** Estimated input scan bytes (null = unknown). */
  scanBytes: number | null;
  /** Estimated input scan rows (null = unknown). */
  scanRows: number | null;
}

/** Group digits for human-readable reasons: 6001215 -> "6,001,215". */
function fmt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

const SEVERITY: Record<GuardDecision, number> = { allow: 0, warn: 1, block: 2 };

/** Pick the more severe of two decisions. */
function worse(a: GuardDecision, b: GuardDecision): GuardDecision {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** Map an ON_UNKNOWN policy to the decision it requests. */
function onUnknownDecision(policy: GuardOnUnknown): GuardDecision {
  return policy; // 'allow' | 'warn' | 'block' map 1:1 to a decision tier.
}

/**
 * Compute the guard verdict (pure function — the unit under test).
 *
 * Two kinds of "cause" contribute a desired decision tier:
 *  - a limit exceedance wants `block` (the strongest a real violation can ask);
 *  - an un-estimable query wants whatever ON_UNKNOWN says (allow/warn/block).
 *
 * The strongest requested tier wins, then `warn` mode caps any `block` down to
 * `warn` (warn mode never blocks). `unsupported` / `disabled` always allow.
 */
export function computeVerdict(input: VerdictInput, limits: GuardLimits): GuardVerdict {
  if (input.status === 'unsupported' || input.status === 'disabled') {
    return { decision: 'allow', reasons: [] };
  }

  const reasons: string[] = [];
  // Each cause requests a decision tier; the strongest wins.
  const requests: GuardDecision[] = [];
  const want = (decision: GuardDecision): void => {
    requests.push(decision);
  };
  // With no limit configured there is nothing to protect, so an un-estimable
  // query is moot — ON_UNKNOWN only applies when a limit is actually set.
  const limitsConfigured = limits.maxScanBytes > 0 || limits.maxScanRows > 0;

  if (input.status === 'unavailable') {
    const decision = onUnknownDecision(limits.onUnknown);
    if (limitsConfigured && decision !== 'allow') {
      reasons.push('Scan cost could not be estimated (estimation unavailable)');
      want(decision);
    }
  } else {
    // status === 'estimated'
    const { scanBytes, scanRows } = input;
    const bytesKnown = scanBytes !== null;
    const rowsKnown = scanRows !== null;

    if (limits.maxScanBytes > 0 && bytesKnown && scanBytes! > limits.maxScanBytes) {
      reasons.push(
        `Estimated scan of ${fmt(scanBytes!)} bytes exceeds the limit of ${fmt(
          limits.maxScanBytes,
        )} bytes`,
      );
      want('block');
    }
    if (limits.maxScanRows > 0 && rowsKnown && scanRows! > limits.maxScanRows) {
      reasons.push(
        `Estimated scan of ${fmt(scanRows!)} rows exceeds the limit of ${fmt(
          limits.maxScanRows,
        )} rows`,
      );
      want('block');
    }

    // Both estimates unknown AND a limit is set -> apply ON_UNKNOWN.
    if (!bytesKnown && !rowsKnown && limitsConfigured) {
      const decision = onUnknownDecision(limits.onUnknown);
      if (decision !== 'allow') {
        reasons.push('Scan cost could not be estimated for this query');
        want(decision);
      }
    }
  }

  const requested = requests.reduce<GuardDecision>((acc, d) => worse(acc, d), 'allow');
  // warn mode never blocks: cap a requested block down to warn.
  const decision = limits.mode === 'warn' && requested === 'block' ? 'warn' : requested;
  return { decision, reasons };
}

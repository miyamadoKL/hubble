import type { EstimateTable } from '@hubble/contracts';

/**
 * Parser for Trino's `EXPLAIN (TYPE IO, FORMAT JSON)` output (Query Guard).
 *
 * The statement returns a single varchar cell holding a JSON document of the
 * shape:
 *
 *   {
 *     "inputTableColumnInfos": [
 *       { "table": { "catalog", "schemaTable": { "schema", "table" } },
 *         "estimate": { "outputRowCount", "outputSizeInBytes", ... } }
 *     ],
 *     "estimate": { "outputRowCount", "outputSizeInBytes", ... }   // query output
 *   }
 *
 * Statistics-less tables emit the *string* `"NaN"` (and possibly `"Infinity"`)
 * in place of numbers; those — and any non-finite value — are treated as `null`
 * (unknown). Per-table scan figures are summed; a sum is `null` only when no
 * input table contributed a finite value.
 */

/** A finite number, or `null` when the value is missing/`"NaN"`/non-finite. */
function finiteOrNull(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  return Number.isFinite(value) ? value : null;
}

interface RawEstimate {
  outputRowCount?: unknown;
  outputSizeInBytes?: unknown;
}

interface RawInputTable {
  table?: {
    catalog?: unknown;
    schemaTable?: { schema?: unknown; table?: unknown };
  };
  estimate?: RawEstimate;
}

interface RawIoPlan {
  inputTableColumnInfos?: RawInputTable[];
  estimate?: RawEstimate;
}

export interface ParsedIoPlan {
  /** Sum of input-table `outputSizeInBytes` (null when wholly unknown). */
  scanBytes: number | null;
  /** Sum of input-table `outputRowCount` (null when wholly unknown). */
  scanRows: number | null;
  /** Top-level query output estimate. */
  outputRows: number | null;
  outputBytes: number | null;
  tables: EstimateTable[];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Parse the single-cell EXPLAIN IO JSON string into scan totals + per-table
 * figures. Returns `undefined` when the cell is not a valid IO plan (e.g. Trino
 * echoed an unsupported statement verbatim instead of a JSON document), which
 * the caller maps to `status: 'unsupported'`.
 */
export function parseExplainIoJson(cell: string): ParsedIoPlan | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(cell);
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const plan = raw as RawIoPlan;
  // A valid IO plan always carries `inputTableColumnInfos` (possibly empty) and
  // an `estimate` object. Absence of both means it is not an IO plan.
  if (!Array.isArray(plan.inputTableColumnInfos) && typeof plan.estimate !== 'object') {
    return undefined;
  }

  const tables: EstimateTable[] = [];
  let scanBytes: number | null = null;
  let scanRows: number | null = null;

  for (const input of plan.inputTableColumnInfos ?? []) {
    const rows = finiteOrNull(input.estimate?.outputRowCount);
    const bytes = finiteOrNull(input.estimate?.outputSizeInBytes);
    tables.push({
      catalog: str(input.table?.catalog),
      schema: str(input.table?.schemaTable?.schema),
      table: str(input.table?.schemaTable?.table),
      rows,
      bytes,
    });
    if (rows !== null) scanRows = (scanRows ?? 0) + rows;
    if (bytes !== null) scanBytes = (scanBytes ?? 0) + bytes;
  }

  return {
    scanBytes,
    scanRows,
    outputRows: finiteOrNull(plan.estimate?.outputRowCount),
    outputBytes: finiteOrNull(plan.estimate?.outputSizeInBytes),
    tables,
  };
}

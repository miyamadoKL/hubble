// Chart data derivation (design.md §5 結果 — チャート). Pure functions that turn
// the loaded result rows + column types into the value-type classification, the
// selectable X/Y axis options, and the sorted/limited rows a chart renders from.
//
// No ECharts and no DOM here — this layer is fully unit-testable. The ECharts
// option assembly lives in `chartOptions.ts`, and the theme (token colors / font)
// in `chartTheme.ts`.

import type { QueryColumn } from '@hubble/contracts';
import type { ResultRow } from '../execution';

/** The five chart kinds we support (design.md §5). */
export type ChartType = 'bars' | 'lines' | 'timeline' | 'pie' | 'scatter';

/** Coarse value class derived from a Trino column type string. */
export type ValueClass = 'number' | 'temporal' | 'string';

export type SortOrder = 'none' | 'asc' | 'desc';

/** Row-count caps offered in the UI; `all` means "the loaded range". */
export const LIMIT_OPTIONS = [5, 10, 25, 50, 100, 'all'] as const;
export type LimitOption = (typeof LIMIT_OPTIONS)[number];

const NUMERIC_TYPE = /^(bigint|integer|int|smallint|tinyint|double|real|decimal|float|numeric)/i;
const TEMPORAL_TYPE = /^(date|time|timestamp|interval)/i;

/** Classify a Trino column type string into a coarse value class. */
export function classifyType(type: string): ValueClass {
  if (NUMERIC_TYPE.test(type)) return 'number';
  if (TEMPORAL_TYPE.test(type)) return 'temporal';
  return 'string';
}

/** A column paired with its index in the result and its derived value class. */
export interface ColumnInfo {
  index: number;
  name: string;
  type: string;
  valueClass: ValueClass;
}

/** Annotate every result column with its index and derived value class. */
export function describeColumns(columns: QueryColumn[]): ColumnInfo[] {
  return columns.map((c, index) => ({
    index,
    name: c.name,
    type: c.type,
    valueClass: classifyType(c.type),
  }));
}

/**
 * Per-cell chart configuration. Column references are by index so they survive a
 * rename and map straight onto a row's positional cells. `yIndices` is the set of
 * (numeric) measures to plot; for pie/scatter only the first is used as the
 * primary value.
 */
export interface ChartConfig {
  type: ChartType;
  xIndex: number | null;
  yIndices: number[];
  sort: SortOrder;
  limit: LimitOption;
  /** scatter only: optional series-grouping (categorical) column. */
  groupIndex?: number | null;
  /** scatter only: optional point-size (numeric) column. */
  sizeIndex?: number | null;
}

/** Which value classes are valid for the X axis of a given chart type. */
export function allowedXClasses(type: ChartType): ValueClass[] {
  switch (type) {
    case 'timeline':
      return ['temporal'];
    case 'scatter':
      return ['number'];
    case 'pie':
      return ['string', 'temporal', 'number'];
    default: // bars / lines
      return ['string', 'temporal', 'number'];
  }
}

/** Candidate X columns for a chart type (filtered by allowed value classes). */
export function xCandidates(cols: ColumnInfo[], type: ChartType): ColumnInfo[] {
  const allowed = allowedXClasses(type);
  return cols.filter((c) => allowed.includes(c.valueClass));
}

/** Candidate Y columns — always numeric (measures). */
export function yCandidates(cols: ColumnInfo[]): ColumnInfo[] {
  return cols.filter((c) => c.valueClass === 'number');
}

/** Candidate grouping columns for scatter (categorical / temporal). */
export function groupCandidates(cols: ColumnInfo[]): ColumnInfo[] {
  return cols.filter((c) => c.valueClass !== 'number');
}

/**
 * Pick a reasonable default config for a fresh result: bars, the first non-numeric
 * column as X (else the first column), and the first numeric column as the single
 * measure. Returns null when there is nothing chartable (no numeric column).
 */
export function defaultConfig(cols: ColumnInfo[]): ChartConfig | null {
  const measures = yCandidates(cols);
  if (measures.length === 0 || cols.length === 0) return null;
  const type: ChartType = 'bars';
  const xs = xCandidates(cols, type);
  // Prefer a categorical/temporal X distinct from the chosen measure.
  const measure = measures[0]!;
  const x =
    xs.find((c) => c.valueClass !== 'number') ??
    xs.find((c) => c.index !== measure.index) ??
    xs[0] ??
    null;
  return {
    type,
    xIndex: x ? x.index : null,
    yIndices: [measure.index],
    sort: 'none',
    limit: 'all',
    groupIndex: null,
    sizeIndex: null,
  };
}

/**
 * Reconcile a stored config against the current columns, dropping references that
 * no longer point at a valid column for the chart type and back-filling sensible
 * defaults. Returns a config that is always renderable (or null if nothing is).
 */
export function reconcileConfig(prev: ChartConfig | null, cols: ColumnInfo[]): ChartConfig | null {
  const fallback = defaultConfig(cols);
  if (!prev) return fallback;
  if (!fallback) return null;

  const measures = new Set(yCandidates(cols).map((c) => c.index));
  const xCols = xCandidates(cols, prev.type);
  const xs = new Set(xCols.map((c) => c.index));
  const groups = new Set(groupCandidates(cols).map((c) => c.index));

  const yIndices = prev.yIndices.filter((i) => measures.has(i));
  // When the stored X is invalid for the (possibly new) chart type, fall back to
  // a column valid for *this* type — prefer a non-measure to keep axes distinct.
  const fallbackY = yIndices[0] ?? fallback.yIndices[0];
  const fallbackX =
    xCols.find((c) => c.index !== fallbackY)?.index ?? xCols[0]?.index ?? null;
  const xIndex = prev.xIndex !== null && xs.has(prev.xIndex) ? prev.xIndex : fallbackX;
  return {
    type: prev.type,
    xIndex,
    yIndices: yIndices.length > 0 ? yIndices : fallback.yIndices,
    sort: prev.sort,
    limit: prev.limit,
    groupIndex:
      prev.groupIndex != null && groups.has(prev.groupIndex) ? prev.groupIndex : null,
    sizeIndex:
      prev.sizeIndex != null && measures.has(prev.sizeIndex) ? prev.sizeIndex : null,
  };
}

/** Coerce a raw cell to a number for numeric axes / measures (NaN → null). */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Coerce a raw cell to a category label for the X axis / grouping. */
export function toLabel(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  return String(value);
}

/**
 * Parse a temporal cell into an epoch-millis timestamp for the time axis. Trino
 * date/timestamp values arrive as strings; we tolerate `T`/space separators.
 * Returns null when unparseable.
 */
export function toTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  // `YYYY-MM-DD HH:MM:SS(.fff)` → ISO so Date.parse is deterministic across TZ.
  const iso = s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Apply the config's sort + limit to the loaded rows. Sorting is by the *first*
 * Y measure (the natural ordering for a chart); `none` keeps result order. The
 * limit caps the row count (`all` = no cap). Returns the windowed row subset.
 */
export function applySortLimit(rows: ReadonlyArray<ResultRow>, config: ChartConfig): ResultRow[] {
  let view = rows.slice();
  const sortKey = config.yIndices[0];
  if (config.sort !== 'none' && sortKey !== undefined) {
    const factor = config.sort === 'asc' ? 1 : -1;
    view = view
      .map((row, i) => ({ row, i }))
      .sort((a, b) => {
        const av = toNumber(a.row[sortKey]);
        const bv = toNumber(b.row[sortKey]);
        if (av === null && bv === null) return a.i - b.i;
        if (av === null) return 1;
        if (bv === null) return -1;
        const cmp = (av - bv) * factor;
        return cmp !== 0 ? cmp : a.i - b.i; // stable
      })
      .map(({ row }) => row);
  }
  if (config.limit !== 'all') {
    view = view.slice(0, config.limit);
  }
  return view;
}

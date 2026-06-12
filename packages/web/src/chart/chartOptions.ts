// ECharts option assembly (design.md §5 結果 — チャート). Builds a complete
// ECharts option object for each of the five chart types from the derived rows +
// config + token theme. Pure — no ECharts runtime, no DOM — so the option shape
// for all five types is unit-testable. The shape matches echarts' `EChartsOption`
// but is typed loosely (`EChartsOptionLike`) to avoid coupling tests to the lib.

import type { QueryColumn } from '@hubble/contracts';
import type { ResultRow } from '../execution';
import {
  applySortLimit,
  toLabel,
  toNumber,
  toTime,
  type ChartConfig,
} from './chartData';
import type { ChartTheme } from './chartTheme';

/** A structurally-typed ECharts option (we only assert on the fields we set). */
export type EChartsOptionLike = Record<string, unknown>;

interface BuildArgs {
  columns: QueryColumn[];
  rows: ReadonlyArray<ResultRow>;
  config: ChartConfig;
  theme: ChartTheme;
}

const AXIS_NAME_GAP = 28;

/** Shared text style + grid so every chart reads as the same instrument. */
function baseOption(theme: ChartTheme): EChartsOptionLike {
  return {
    color: theme.series,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: theme.fontFamily, color: theme.ink },
    animationDuration: 150,
    grid: { left: 56, right: 20, top: 36, bottom: 48, containLabel: true },
    legend: {
      type: 'scroll',
      top: 4,
      textStyle: { color: theme.inkMuted, fontSize: 11, fontFamily: theme.fontFamily },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
    },
    tooltip: {
      trigger: 'item',
      backgroundColor: theme.surfaceRaised,
      borderColor: theme.border,
      borderWidth: 1,
      textStyle: { color: theme.ink, fontSize: 12, fontFamily: theme.fontFamily },
      extraCssText: 'box-shadow:none;border-radius:6px;',
    },
  };
}

function categoryAxis(theme: ChartTheme, name: string): EChartsOptionLike {
  return {
    type: 'category',
    name,
    nameLocation: 'middle',
    nameGap: AXIS_NAME_GAP + 8,
    nameTextStyle: { color: theme.inkMuted, fontSize: 11 },
    axisLabel: {
      color: theme.inkMuted,
      fontSize: 11,
      fontFamily: theme.fontMono,
      hideOverlap: true,
    },
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { show: false },
  };
}

function valueAxis(theme: ChartTheme, name?: string): EChartsOptionLike {
  return {
    type: 'value',
    name,
    nameTextStyle: { color: theme.inkMuted, fontSize: 11 },
    axisLabel: { color: theme.inkMuted, fontSize: 11, fontFamily: theme.fontMono },
    axisLine: { show: false },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: theme.borderSubtle, type: 'dashed' } },
  };
}

function timeAxis(theme: ChartTheme, name: string): EChartsOptionLike {
  return {
    type: 'time',
    name,
    nameLocation: 'middle',
    nameGap: AXIS_NAME_GAP + 8,
    nameTextStyle: { color: theme.inkMuted, fontSize: 11 },
    axisLabel: { color: theme.inkMuted, fontSize: 11, fontFamily: theme.fontMono },
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { show: false },
    splitLine: { show: false },
  };
}

function colName(columns: QueryColumn[], index: number | null | undefined): string {
  if (index === null || index === undefined) return '';
  return columns[index]?.name ?? `col ${index}`;
}

/**
 * Build the complete ECharts option for the configured chart. Returns null when
 * the config can't render (no X for a categorical chart, no measure, etc.) so the
 * caller can show a guidance state instead of a broken chart.
 */
export function buildChartOption(args: BuildArgs): EChartsOptionLike | null {
  const { config } = args;
  switch (config.type) {
    case 'bars':
    case 'lines':
      return buildCartesian(args, config.type);
    case 'timeline':
      return buildTimeline(args);
    case 'pie':
      return buildPie(args);
    case 'scatter':
      return buildScatter(args);
    default:
      return null;
  }
}

/** Bars / lines over a category X axis with one series per Y measure. */
function buildCartesian(args: BuildArgs, type: 'bars' | 'lines'): EChartsOptionLike | null {
  const { columns, rows, config, theme } = args;
  if (config.xIndex === null || config.yIndices.length === 0) return null;
  const view = applySortLimit(rows, config);
  const categories = view.map((r) => toLabel(r[config.xIndex!]));
  const series = config.yIndices.map((yi) => ({
    name: colName(columns, yi),
    type: type === 'bars' ? 'bar' : 'line',
    data: view.map((r) => toNumber(r[yi])),
    ...(type === 'bars'
      ? { barMaxWidth: 28, itemStyle: { borderRadius: [2, 2, 0, 0] } }
      : { smooth: false, showSymbol: view.length <= 80, symbolSize: 5, lineStyle: { width: 2 } }),
  }));
  return {
    ...baseOption(theme),
    tooltip: { ...(baseOption(theme).tooltip as object), trigger: 'axis' },
    xAxis: { ...categoryAxis(theme, colName(columns, config.xIndex)), data: categories },
    yAxis: valueAxis(theme),
    series,
  };
}

/** Timeline: a time X axis (date/timestamp) with one line/series per measure. */
function buildTimeline(args: BuildArgs): EChartsOptionLike | null {
  const { columns, rows, config, theme } = args;
  if (config.xIndex === null || config.yIndices.length === 0) return null;
  // For a time axis, sort by time ascending unless the user forced a measure sort.
  const view =
    config.sort === 'none'
      ? sortByTime(rows, config.xIndex)
      : applySortLimit(rows, config);
  const limited =
    config.limit === 'all' ? view : view.slice(0, config.limit);

  const series = config.yIndices.map((yi) => ({
    name: colName(columns, yi),
    type: 'line',
    showSymbol: limited.length <= 80,
    symbolSize: 5,
    smooth: false,
    lineStyle: { width: 2 },
    data: limited.map((r) => [toTime(r[config.xIndex!]), toNumber(r[yi])]),
  }));
  return {
    ...baseOption(theme),
    tooltip: { ...(baseOption(theme).tooltip as object), trigger: 'axis' },
    xAxis: timeAxis(theme, colName(columns, config.xIndex)),
    yAxis: valueAxis(theme),
    series,
  };
}

/** Pie: X column as slice labels, first Y measure as slice values. */
function buildPie(args: BuildArgs): EChartsOptionLike | null {
  const { columns, rows, config, theme } = args;
  const yi = config.yIndices[0];
  if (config.xIndex === null || yi === undefined) return null;
  const view = applySortLimit(rows, config);
  const data = view.map((r) => ({
    name: toLabel(r[config.xIndex!]),
    value: toNumber(r[yi]) ?? 0,
  }));
  return {
    ...baseOption(theme),
    grid: undefined,
    tooltip: { ...(baseOption(theme).tooltip as object), trigger: 'item' },
    legend: {
      ...(baseOption(theme).legend as object),
      type: 'scroll',
      orient: 'vertical',
      right: 8,
      top: 'middle',
    },
    series: [
      {
        name: colName(columns, yi),
        type: 'pie',
        radius: ['38%', '70%'],
        center: ['42%', '54%'],
        itemStyle: { borderColor: theme.surfaceRaised, borderWidth: 2 },
        label: { color: theme.inkMuted, fontSize: 11, fontFamily: theme.fontFamily },
        labelLine: { lineStyle: { color: theme.border } },
        data,
      },
    ],
  };
}

/** Scatter: numeric X vs first numeric Y, optional grouping series + size column. */
function buildScatter(args: BuildArgs): EChartsOptionLike | null {
  const { columns, rows, config, theme } = args;
  const yi = config.yIndices[0];
  if (config.xIndex === null || yi === undefined) return null;
  const view = config.limit === 'all' ? rows.slice() : rows.slice(0, config.limit);

  const sizeIndex = config.sizeIndex ?? null;
  const sizeExtent = sizeIndex !== null ? extent(view, sizeIndex) : null;
  const sizeFor = (row: ResultRow): number => {
    if (sizeIndex === null || !sizeExtent) return 8;
    const v = toNumber(row[sizeIndex]);
    if (v === null || sizeExtent.max === sizeExtent.min) return 8;
    const ratio = (v - sizeExtent.min) / (sizeExtent.max - sizeExtent.min);
    return 6 + ratio * 22; // 6..28 px
  };

  const point = (row: ResultRow): unknown[] => [toNumber(row[config.xIndex!]), toNumber(row[yi])];

  let series: EChartsOptionLike[];
  if (config.groupIndex != null) {
    const groups = new Map<string, ResultRow[]>();
    for (const row of view) {
      const key = toLabel(row[config.groupIndex]);
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
    }
    series = [...groups.entries()].map(([name, groupRows]) => ({
      name,
      type: 'scatter',
      data: groupRows.map((r) => ({ value: point(r), symbolSize: sizeFor(r) })),
    }));
  } else {
    series = [
      {
        name: colName(columns, yi),
        type: 'scatter',
        data: view.map((r) => ({ value: point(r), symbolSize: sizeFor(r) })),
      },
    ];
  }

  return {
    ...baseOption(theme),
    xAxis: valueAxis(theme, colName(columns, config.xIndex)),
    yAxis: valueAxis(theme, colName(columns, yi)),
    series,
  };
}

// ---- small helpers ----------------------------------------------------------

function sortByTime(rows: ReadonlyArray<ResultRow>, xIndex: number): ResultRow[] {
  return rows
    .slice()
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const at = toTime(a.row[xIndex]);
      const bt = toTime(b.row[xIndex]);
      if (at === null && bt === null) return a.i - b.i;
      if (at === null) return 1;
      if (bt === null) return -1;
      return at - bt || a.i - b.i;
    })
    .map(({ row }) => row);
}

function extent(rows: ReadonlyArray<ResultRow>, index: number): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const v = toNumber(row[index]);
    if (v === null) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return min === Infinity ? null : { min, max };
}

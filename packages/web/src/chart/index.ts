// Public surface of the chart feature layer (design.md §5 結果 — チャート).
// Components import from here; the ECharts runtime is loaded lazily by the
// ChartView component, never at module load.

export {
  classifyType,
  describeColumns,
  xCandidates,
  yCandidates,
  groupCandidates,
  allowedXClasses,
  defaultConfig,
  reconcileConfig,
  applySortLimit,
  toNumber,
  toLabel,
  toTime,
  LIMIT_OPTIONS,
  type ChartType,
  type ValueClass,
  type SortOrder,
  type LimitOption,
  type ColumnInfo,
  type ChartConfig,
} from './chartData';
export { buildChartOption, type EChartsOptionLike } from './chartOptions';
export { readChartTheme, type ChartTheme } from './chartTheme';

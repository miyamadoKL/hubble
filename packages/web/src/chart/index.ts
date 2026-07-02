// ============================================================================
// 【ファイル概要】
// このファイルは、チャート機能レイヤーの公開API（外部に公開する関数と型）を
// まとめて re-export するバレルファイル。コンポーネント側は個々の実装ファイル
// （chartData.ts / chartOptions.ts / chartTheme.ts）を直接importせず、
// このファイル経由でチャート関連のシンボルを取得する。
// なお ECHarts のランタイム自体はここではロードせず、実際にチャートを描画する
// ChartView コンポーネント側で遅延ロードされる（echartsLoader.ts参照）。
// ============================================================================
// Public surface of the chart feature layer (design.md §5 結果: チャート).
// Components import from here; the ECharts runtime is loaded lazily by the
// ChartView component, never at module load.

// chartData.ts: 値の分類、軸候補の抽出、デフォルト設定生成、データ変換関数群。
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
// chartOptions.ts: ECharts option 組み立て関数と、その戻り値の型。
export { buildChartOption, type EChartsOptionLike } from './chartOptions';
// chartTheme.ts: デザイントークンから解決したチャート用テーマの読み取り関数と型。
export { readChartTheme, type ChartTheme } from './chartTheme';

// ============================================================================
// 【ファイル概要】
// このファイルは、チャート設定（ChartConfig）、行データ、テーマ（ChartTheme）から
// ECharts に渡す option オブジェクトを組み立てる処理を担う。
// チャート種別（bars/lines/timeline/pie/scatter）ごとに専用の組み立て関数を持ち、
// 共通のベースオプション（配色、フォント、グリッド、凡例、ツールチップ）に、
// 種別ごとの axis/series を合成して最終的な option を返す。
// ECharts のランタイムや DOM には依存しないため、5種類すべての option の形状を
// 単体テストで検証できる。
// ============================================================================
// ECharts option assembly (design.md §5 結果: チャート). Builds a complete
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

/**
 * A structurally-typed ECharts option (we only assert on the fields we set).
 * ECharts の option オブジェクトを緩く型付けしたもの。実際に設定するフィールドのみ
 * を保証する構造的な型で、echarts 本体の型に強く結合しないための妥協。
 */
export type EChartsOptionLike = Record<string, unknown>;

// 各 build*関数に渡す共通の引数セット。
interface BuildArgs {
  /** クエリ結果のカラム定義（軸名と凡例名の解決に使う）。 */
  columns: QueryColumn[];
  /** クエリ結果の行データ（未加工）。 */
  rows: ReadonlyArray<ResultRow>;
  /** チャート設定（種別、軸、ソート、件数制限など）。 */
  config: ChartConfig;
  /** 配色やフォントなどのテーマトークン。 */
  theme: ChartTheme;
}

// 軸名ラベルと軸線の間の余白（px）。カテゴリ軸や時間軸のnameGap計算に使う基準値。
const AXIS_NAME_GAP = 28;

/**
 * Shared text style + grid so every chart reads as the same instrument.
 * 全チャート種別で共通のベースオプション（配色、フォント、グリッド余白、凡例、
 * ツールチップの見た目）を組み立てる。個別の build*関数はこれをスプレッドで
 * ベースにし、必要な差分（axis, series など）を上書きし、追加する。
 */
function baseOption(theme: ChartTheme): EChartsOptionLike {
  return {
    // シリーズの配色はテーマの --chart-1..6 トークンから解決された色を使う。
    color: theme.series,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: theme.fontFamily, color: theme.ink },
    // アニメーションは短めにして、データ更新時のちらつきを抑えつつ即応性を保つ。
    animationDuration: 150,
    // 軸ラベルがはみ出さないよう containLabel を有効化し、周囲に余白を確保する。
    grid: { left: 56, right: 20, top: 36, bottom: 48, containLabel: true },
    legend: {
      // 凡例が多い場合はスクロール可能にする。
      type: 'scroll',
      top: 4,
      textStyle: { color: theme.inkMuted, fontSize: 11, fontFamily: theme.fontFamily },
      icon: 'roundRect',
      itemWidth: 10,
      itemHeight: 10,
    },
    tooltip: {
      // デフォルトは要素単位（item）でのツールチップ。カテゴリ系チャートでは
      // 呼び出し側で 'axis' に上書きする。
      trigger: 'item',
      backgroundColor: theme.surfaceRaised,
      borderColor: theme.border,
      borderWidth: 1,
      textStyle: { color: theme.ink, fontSize: 12, fontFamily: theme.fontFamily },
      extraCssText: 'box-shadow:none;border-radius:6px;',
    },
  };
}

// カテゴリ軸（棒グラフや折れ線グラフのX軸）の共通スタイルを組み立てる。
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
      // ラベルが密集して重なる場合は間引いて表示する。
      hideOverlap: true,
    },
    axisLine: { lineStyle: { color: theme.border } },
    axisTick: { show: false },
  };
}

// 数値軸（Y軸、および散布図のX/Y軸）の共通スタイルを組み立てる。
function valueAxis(theme: ChartTheme, name?: string): EChartsOptionLike {
  return {
    type: 'value',
    name,
    nameTextStyle: { color: theme.inkMuted, fontSize: 11 },
    axisLabel: { color: theme.inkMuted, fontSize: 11, fontFamily: theme.fontMono },
    axisLine: { show: false },
    axisTick: { show: false },
    // 目盛り線は破線で控えめに表示する。
    splitLine: { lineStyle: { color: theme.borderSubtle, type: 'dashed' } },
  };
}

// 時間軸（タイムラインチャートのX軸）の共通スタイルを組み立てる。
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
    // 時間軸では目盛り線を表示しない（データ点自体が密なため）。
    splitLine: { show: false },
  };
}

// カラム index から表示名を解決する。index が未指定なら空文字、カラム情報が
// 見つからない場合は "col {index}" というフォールバック名を返す。
function colName(columns: QueryColumn[], index: number | null | undefined): string {
  if (index === null || index === undefined) return '';
  return columns[index]?.name ?? `col ${index}`;
}

/**
 * Build the complete ECharts option for the configured chart. Returns null when
 * the config can't render (no X for a categorical chart, no measure, etc.) so the
 * caller can show a guidance state instead of a broken chart.
 * 設定されたチャート種別に応じて、対応する build*関数へディスパッチし、
 * 完成した ECharts option を返す。設定が描画不能な場合（X軸未選択や測定値
 * 未選択など）は null を返し、呼び出し側はエラー表示ではなく「設定を促す」
 * ガイダンス表示に切り替えられるようにする。
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

/**
 * Bars / lines over a category X axis with one series per Y measure.
 * 棒グラフや折れ線グラフの option を組み立てる。X軸はカテゴリ軸で、
 * yIndices に含まれる測定値カラムそれぞれについて1本の系列（series）を生成する
 * （複数選択時はマルチシリーズの棒／折れ線グラフになる）。
 */
function buildCartesian(args: BuildArgs, type: 'bars' | 'lines'): EChartsOptionLike | null {
  const { columns, rows, config, theme } = args;
  // X軸未選択、または測定値が1つも無ければ描画不能。
  if (config.xIndex === null || config.yIndices.length === 0) return null;
  // 設定のソート順と件数上限を適用した行データを取得する。
  const view = applySortLimit(rows, config);
  // 各行のX軸カラムをカテゴリラベル文字列に変換し、カテゴリ軸の data とする。
  const categories = view.map((r) => toLabel(r[config.xIndex!]));
  // yIndices の各測定値カラムごとに1系列を生成する。
  const series = config.yIndices.map((yi) => ({
    name: colName(columns, yi),
    type: type === 'bars' ? 'bar' : 'line',
    // 各行の当該measureカラムを数値化してdataとする（数値化できない値はnull）。
    data: view.map((r) => toNumber(r[yi])),
    // 棒グラフは最大幅と角丸、折れ線は直線補間、シンボル表示条件、線幅を設定する。
    // 折れ線はデータ点が多いとシンボルが重なるため、80件以下のときだけ表示する。
    ...(type === 'bars'
      ? { barMaxWidth: 28, itemStyle: { borderRadius: [2, 2, 0, 0] } }
      : { smooth: false, showSymbol: view.length <= 80, symbolSize: 5, lineStyle: { width: 2 } }),
  }));
  return {
    ...baseOption(theme),
    // カテゴリ軸系のチャートはツールチップを axis トリガー（同じX位置の全系列を
    // まとめて表示）に上書きする。
    tooltip: { ...(baseOption(theme).tooltip as object), trigger: 'axis' },
    xAxis: { ...categoryAxis(theme, colName(columns, config.xIndex)), data: categories },
    yAxis: valueAxis(theme),
    series,
  };
}

/**
 * Timeline: a time X axis (date/timestamp) with one line/series per measure.
 * タイムラインチャートの option を組み立てる。X軸は時間軸(date/timestamp)で、
 * yIndices の各測定値カラムごとに1本の折れ線系列を生成する。
 */
function buildTimeline(args: BuildArgs): EChartsOptionLike | null {
  const { columns, rows, config, theme } = args;
  if (config.xIndex === null || config.yIndices.length === 0) return null;
  // For a time axis, sort by time ascending unless the user forced a measure sort.
  // ユーザーが明示的に測定値でのソートを指定していない限り、時間軸としては
  // 時刻昇順で並べるのが自然なので sortByTime を使う。'none' 以外が指定されて
  // いれば、そのソート指定（測定値基準）を applySortLimit に委ねる。
  const view =
    config.sort === 'none'
      ? sortByTime(rows, config.xIndex)
      : applySortLimit(rows, config);
  // applySortLimit 側で件数上限が未適用のケース（sortByTimeを使った場合）を
  // ここで別途スライスして揃える。
  const limited =
    config.limit === 'all' ? view : view.slice(0, config.limit);

  const series = config.yIndices.map((yi) => ({
    name: colName(columns, yi),
    type: 'line',
    // データ点が多いとシンボルが重なるため、80件以下のときだけ表示する。
    showSymbol: limited.length <= 80,
    symbolSize: 5,
    smooth: false,
    lineStyle: { width: 2 },
    // 時間軸チャートのdataは [時刻(ms), 値] のペア配列で表現する。
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

/**
 * Pie: X column as slice labels, first Y measure as slice values.
 * 円グラフの option を組み立てる。X軸カラムを各スライスのラベルに、
 * 最初のY測定値カラムをスライスの値（割合の元になる量）として使う
 * （円グラフは測定値を1つしか扱えないため yIndices[0] のみ参照）。
 */
function buildPie(args: BuildArgs): EChartsOptionLike | null {
  const { columns, rows, config, theme } = args;
  const yi = config.yIndices[0];
  if (config.xIndex === null || yi === undefined) return null;
  const view = applySortLimit(rows, config);
  // 各行を { name: ラベル, value: 数値 } のスライスデータに変換する。
  // 数値化できない値は 0 として扱う（円グラフでは負値と欠損は描画上意味を持たないため）。
  const data = view.map((r) => ({
    name: toLabel(r[config.xIndex!]),
    value: toNumber(r[yi]) ?? 0,
  }));
  return {
    ...baseOption(theme),
    // 円グラフはカテゴリ軸/数値軸を使わないので grid は不要（undefinedで無効化）。
    grid: undefined,
    tooltip: { ...(baseOption(theme).tooltip as object), trigger: 'item' },
    legend: {
      // 円グラフは凡例を右側に縦並びで表示するレイアウトに変更する。
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
        // ドーナツ状（内径38%〜外径70%）にして中心にラベル配置の余地を残す。
        radius: ['38%', '70%'],
        // 凡例分のスペースを右に確保するため中心をやや左寄せにする。
        center: ['42%', '54%'],
        itemStyle: { borderColor: theme.surfaceRaised, borderWidth: 2 },
        label: { color: theme.inkMuted, fontSize: 11, fontFamily: theme.fontFamily },
        labelLine: { lineStyle: { color: theme.border } },
        data,
      },
    ],
  };
}

/**
 * Scatter: numeric X vs first numeric Y, optional grouping series + size column.
 * 散布図の option を組み立てる。X軸とY軸はともに数値カラム（Y軸は最初の測定値）。
 * オプションで groupIndex（カテゴリ列によるグルーピング＝系列分け）と
 * sizeIndex（数値列によるバブルサイズのマッピング）を指定できる。
 */
function buildScatter(args: BuildArgs): EChartsOptionLike | null {
  const { columns, rows, config, theme } = args;
  const yi = config.yIndices[0];
  if (config.xIndex === null || yi === undefined) return null;
  // 散布図はソート概念が無いため、applySortLimitではなく単純に件数のみ制限する。
  const view = config.limit === 'all' ? rows.slice() : rows.slice(0, config.limit);

  const sizeIndex = config.sizeIndex ?? null;
  // サイズカラムが指定されている場合、その値域（最小と最大）を先に求めておき、
  // 各点のサイズをこの範囲内での相対位置として計算する。
  const sizeExtent = sizeIndex !== null ? extent(view, sizeIndex) : null;
  const sizeFor = (row: ResultRow): number => {
    // サイズカラム未指定、または値域が取得できない場合は固定サイズ(8px)。
    if (sizeIndex === null || !sizeExtent) return 8;
    const v = toNumber(row[sizeIndex]);
    // 値が無い、または値域の最小最大が同じ（全点同値）場合も固定サイズにする。
    if (v === null || sizeExtent.max === sizeExtent.min) return 8;
    // 値域内での相対位置（0〜1）を求め、6px〜28pxの範囲に線形マッピングする。
    const ratio = (v - sizeExtent.min) / (sizeExtent.max - sizeExtent.min);
    return 6 + ratio * 22; // 6..28 px
  };

  // 1行分のデータ点を [X値, Y値] のペアに変換するヘルパー。
  const point = (row: ResultRow): unknown[] => [toNumber(row[config.xIndex!]), toNumber(row[yi])];

  let series: EChartsOptionLike[];
  if (config.groupIndex != null) {
    // グルーピング指定あり: groupIndex カラムの値ごとに行をバケット分けし、
    // グループごとに1つの散布図系列を生成する（凡例で系列を切り替えられる）。
    const groups = new Map<string, ResultRow[]>();
    for (const row of view) {
      const key = toLabel(row[config.groupIndex]);
      // Map に未登録のキーなら空配列で初期化してからpushする（存在すればそれを使う）。
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(row);
    }
    series = [...groups.entries()].map(([name, groupRows]) => ({
      name,
      type: 'scatter',
      data: groupRows.map((r) => ({ value: point(r), symbolSize: sizeFor(r) })),
    }));
  } else {
    // グルーピング指定なし: 全行を1つの系列にまとめる。
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

// 行データをX軸カラムの時刻昇順にソートするヘルパー（タイムラインのデフォルト順）。
// 元のインデックスiを保持して安定ソートにし、パース不能な時刻の行は末尾に寄せる。
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

// 指定カラムの数値としての最小値と最大値（値域）を求めるヘルパー。
// 数値化できない値はスキップし、有効な値が1つも無ければ null を返す
// （散布図のバブルサイズの正規化に使用）。
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

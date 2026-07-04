// ============================================================================
// 【ファイル概要】
// このファイルは、クエリ結果の行データ（ResultRow）とカラム情報から、チャート描画に
// 必要なデータを導出する純粋関数群を提供する。具体的には以下を行う:
//   - カラムの型文字列から値の分類（数値／日時／文字列）を判定する
//   - チャート種別ごとに X軸／Y軸／グルーピング軸として選択可能なカラムを絞り込む
//   - デフォルトのチャート設定を組み立てる／既存設定を現在のカラム構成に合わせて調整する
//   - 生の行データをチャート用の数値、ラベル、タイムスタンプに変換する
//   - ソート順と表示件数の上限を行データに適用する
// ECharts や DOM には一切依存しないため、単体テストがしやすい設計になっている。
// ECharts のオプション組み立ては chartOptions.ts、テーマ（配色やフォント）の解決は
// chartTheme.ts が担当する。
// ============================================================================
// Chart data derivation (結果: チャート). Pure functions that turn
// the loaded result rows + column types into the value-type classification, the
// selectable X/Y axis options, and the sorted/limited rows a chart renders from.
//
// No ECharts and no DOM here — this layer is fully unit-testable. The ECharts
// option assembly lives in `chartOptions.ts`, and the theme (token colors / font)
// in `chartTheme.ts`.

import type { QueryColumn } from '@hubble/contracts';
import type { ResultRow } from '../execution';

/**
 * The five chart kinds we support.
 * サポートするチャート種別: 棒グラフ(bars) / 折れ線(lines) / タイムライン(timeline)
 * / 円グラフ(pie) / 散布図(scatter) の5種類。
 */
export type ChartType = 'bars' | 'lines' | 'timeline' | 'pie' | 'scatter';

/**
 * Coarse value class derived from a Trino column type string.
 * Trino のカラム型文字列から導出される大まかな値の分類。
 * 'number'（数値）/ 'temporal'（日時系）/ 'string'（その他、文字列扱い）の3種。
 * この分類が、各チャート種別でどのカラムを軸として選べるかの判定基準になる。
 */
export type ValueClass = 'number' | 'temporal' | 'string';

/**
 * ソート順の指定。'none' はソートなし（クエリ結果の並び順のまま）、
 * 'asc' は第一Y測定値の昇順、'desc' は同降順（`applySortLimit` 参照）。
 */
export type SortOrder = 'none' | 'asc' | 'desc';

/** Row-count caps offered in the UI; `all` means "the loaded range". */
// UI 上で選択可能な表示件数の上限候補。'all' はロード済みの全行を表示する特別値。
export const LIMIT_OPTIONS = [5, 10, 25, 50, 100, 'all'] as const;
/** LIMIT_OPTIONS の要素から導かれる型（5 | 10 | 25 | 50 | 100 | 'all'）。 */
export type LimitOption = (typeof LIMIT_OPTIONS)[number];

// カラム型文字列が数値系かどうかを判定する正規表現（先頭一致、大文字小文字無視）。
// bigint/integer/int/smallint/tinyint は整数系、double/real/decimal/float/numeric は浮動小数と精度指定系。
const NUMERIC_TYPE = /^(bigint|integer|int|smallint|tinyint|double|real|decimal|float|numeric)/i;
// カラム型文字列が日時系かどうかを判定する正規表現。date/time/timestamp/interval が対象。
const TEMPORAL_TYPE = /^(date|time|timestamp|interval)/i;

/**
 * Classify a Trino column type string into a coarse value class.
 * Trino のカラム型文字列を大まかな値クラスに分類する。
 * 数値系の正規表現にマッチすれば 'number'、日時系にマッチすれば 'temporal'、
 * どちらでもなければ（文字列や真偽値、複合型など）'string' として扱う。
 */
export function classifyType(type: string): ValueClass {
  if (NUMERIC_TYPE.test(type)) return 'number';
  if (TEMPORAL_TYPE.test(type)) return 'temporal';
  return 'string';
}

/**
 * A column paired with its index in the result and its derived value class.
 * 結果内でのインデックス（列位置）と、導出された値クラスを併せ持つカラム情報。
 * チャート機能ではカラムを名前ではなく index で参照するため、この構造体が
 * 以降の候補抽出と設定生成の基本単位になる。
 */
export interface ColumnInfo {
  index: number;
  name: string;
  type: string;
  valueClass: ValueClass;
}

/**
 * Annotate every result column with its index and derived value class.
 * クエリ結果の各カラムに、結果内でのインデックスと値クラスを付与した
 * ColumnInfo の配列を生成する。以降のチャート設定処理はすべてこの配列を入力とする。
 */
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
 * セル単位のチャート設定。カラムはカラム名ではなく index（位置）で参照するため、
 * カラム名の変更があっても設定が壊れにくく、また行データへのアクセスも
 * ポジショナルにそのまま行える。yIndices は描画対象とする（数値）測定値の集合で、
 * pie（円グラフ）や scatter（散布図）では先頭の要素のみが主たる値として使われる。
 */
export interface ChartConfig {
  /** チャート種別。 */
  type: ChartType;
  /** X軸に使うカラムの index。未選択の場合は null。 */
  xIndex: number | null;
  /** Y軸（測定値）に使うカラムの index の配列。複数選択で複数系列になる。 */
  yIndices: number[];
  /** 行のソート順。 */
  sort: SortOrder;
  /** 表示行数の上限。'all' は上限なし。 */
  limit: LimitOption;
  /** scatter only: optional series-grouping (categorical) column. */
  groupIndex?: number | null;
  /** scatter only: optional point-size (numeric) column. */
  sizeIndex?: number | null;
}

/**
 * Which value classes are valid for the X axis of a given chart type.
 * 指定したチャート種別で X軸として許容される値クラスを返す。
 * timeline は日時のみ、scatter は数値のみ、それ以外（bars/lines/pie）は
 * 文字列、日時、数値のいずれも許容する。
 */
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

/**
 * Candidate X columns for a chart type (filtered by allowed value classes).
 * 指定したチャート種別で X軸の候補となるカラムを、allowedXClasses が返す
 * 許容値クラスでフィルタして返す。
 */
export function xCandidates(cols: ColumnInfo[], type: ChartType): ColumnInfo[] {
  const allowed = allowedXClasses(type);
  return cols.filter((c) => allowed.includes(c.valueClass));
}

/**
 * Candidate Y columns — always numeric (measures).
 * Y軸（測定値）の候補となるカラムを返す。Y軸は常に数値カラムのみが対象。
 */
export function yCandidates(cols: ColumnInfo[]): ColumnInfo[] {
  return cols.filter((c) => c.valueClass === 'number');
}

/**
 * Candidate grouping columns for scatter (categorical / temporal).
 * scatter（散布図）でのグルーピング（系列分け）に使えるカラム候補を返す。
 * 数値以外（文字列と日時）のカラムがグルーピングキーとして使える。
 */
export function groupCandidates(cols: ColumnInfo[]): ColumnInfo[] {
  return cols.filter((c) => c.valueClass !== 'number');
}

/**
 * Pick a reasonable default config for a fresh result: bars, the first non-numeric
 * column as X (else the first column), and the first numeric column as the single
 * measure. Returns null when there is nothing chartable (no numeric column).
 * 新規の結果に対する妥当なデフォルト設定を組み立てる。
 * チャート種別は 'bars'（棒グラフ）固定、X軸は「数値以外の先頭カラム」を優先し、
 * 見つからなければ他の候補で埋める。Y軸（測定値）は最初の数値カラム1つを採用する。
 * 数値カラムが1つも無い場合はチャート化できないため null を返す。
 */
export function defaultConfig(cols: ColumnInfo[]): ChartConfig | null {
  const measures = yCandidates(cols);
  // 数値カラムが無い、またはカラム自体が無い場合はチャート化不可能。
  if (measures.length === 0 || cols.length === 0) return null;
  const type: ChartType = 'bars';
  const xs = xCandidates(cols, type);
  // Prefer a categorical/temporal X distinct from the chosen measure.
  // Y軸に使う先頭の数値カラムを測定値として確定させる。
  const measure = measures[0]!;
  // X軸の選定優先順位:
  //   1. 数値以外（文字列と日時）の候補カラム → X軸とY軸の意味を分離できるので最優先
  //   2. 測定値カラムとインデックスが異なる候補（数値同士でも軸を分けたい）
  //   3. それでも見つからなければ候補の先頭
  //   4. 候補が一つも無ければ X軸なし（null）
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
 * 保存済みのチャート設定を、現在のカラム構成に照らして再検証し、調整する。
 * クエリが再実行されてカラム構成が変わった場合などに、もはや存在しない／型が
 * 合わなくなったカラム参照を取り除き、必要に応じて妥当なデフォルトで補完する。
 * 常に描画可能な設定（あるいはどうしても描画不能なら null）を返す。
 */
export function reconcileConfig(prev: ChartConfig | null, cols: ColumnInfo[]): ChartConfig | null {
  // 現在のカラム構成から算出した「まっさらな」デフォルト設定（フォールバック用）。
  const fallback = defaultConfig(cols);
  // 以前の設定が無ければデフォルトをそのまま採用する。
  if (!prev) return fallback;
  // デフォルトすら組み立てられない（チャート化できるカラムが無い）場合は諦める。
  if (!fallback) return null;

  // 現在有効な測定値（数値カラム）の index 集合。
  const measures = new Set(yCandidates(cols).map((c) => c.index));
  // 以前のチャート種別に対して、現在有効な X軸候補カラムとその index 集合。
  const xCols = xCandidates(cols, prev.type);
  const xs = new Set(xCols.map((c) => c.index));
  // 現在有効なグルーピング候補カラムの index 集合。
  const groups = new Set(groupCandidates(cols).map((c) => c.index));

  // 以前の yIndices のうち、現在も数値カラムとして存在するものだけを残す。
  const yIndices = prev.yIndices.filter((i) => measures.has(i));
  // When the stored X is invalid for the (possibly new) chart type, fall back to
  // a column valid for *this* type — prefer a non-measure to keep axes distinct.
  // X軸のフォールバック計算に使う「代表Y」: 生き残ったYがあればその先頭、
  // 無ければデフォルト設定のY。
  const fallbackY = yIndices[0] ?? fallback.yIndices[0];
  // X軸のフォールバック候補: Y軸と異なるカラムを優先し、無ければ候補の先頭。
  const fallbackX = xCols.find((c) => c.index !== fallbackY)?.index ?? xCols[0]?.index ?? null;
  // 保存済みの xIndex が現在も有効な候補ならそのまま使い、無効ならフォールバックへ。
  const xIndex = prev.xIndex !== null && xs.has(prev.xIndex) ? prev.xIndex : fallbackX;
  return {
    type: prev.type,
    xIndex,
    // Y候補が一つも生き残らなかった場合はデフォルトのYで補完する。
    yIndices: yIndices.length > 0 ? yIndices : fallback.yIndices,
    sort: prev.sort,
    limit: prev.limit,
    // グルーピングカラムが現在も有効な候補でなければ未選択（null）に戻す。
    groupIndex: prev.groupIndex != null && groups.has(prev.groupIndex) ? prev.groupIndex : null,
    // サイズカラムが現在も有効な数値カラムでなければ未選択（null）に戻す。
    sizeIndex: prev.sizeIndex != null && measures.has(prev.sizeIndex) ? prev.sizeIndex : null,
  };
}

/**
 * Coerce a raw cell to a number for numeric axes / measures (NaN → null).
 * 生のセル値を数値軸や測定値用の number に変換する。null/undefined や
 * 数値に変換できない値（NaN になるもの）は null として扱う。
 */
export function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // すでに number 型ならそのまま使う。ただし Infinity/NaN は不正値として弾く。
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // 文字列など number 型でない値は Number() で変換を試みる。
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce a raw cell to a category label for the X axis / grouping.
 * 生のセル値を X軸ラベル／グルーピングキー用の文字列に変換する。
 * null/undefined は「空集合」を表す記号 '∅' として表示する。
 */
export function toLabel(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  return String(value);
}

/**
 * Parse a temporal cell into an epoch-millis timestamp for the time axis. Trino
 * date/timestamp values arrive as strings; we tolerate `T`/space separators.
 * Returns null when unparseable.
 * 日時系のセル値を、time 軸で使うエポックミリ秒のタイムスタンプに変換する。
 * Trino の date/timestamp 値は文字列として届くため、`T` 区切りや半角スペース区切り
 * のどちらでも解釈できるよう吸収する。パース不能な場合は null を返す。
 */
export function toTime(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  // すでに数値（エポックミリ秒相当）ならそのまま返す。
  if (typeof value === 'number') return value;
  const s = String(value).trim();
  // `YYYY-MM-DD HH:MM:SS(.fff)` → ISO so Date.parse is deterministic across TZ.
  // Trino が返す "YYYY-MM-DD HH:MM:SS" 形式（スペース区切り、T を含まない）を
  // ISO 8601 形式（T区切り）に変換する。これにより Date.parse の挙動がタイムゾーンに
  // 依らず決定的になる。
  const iso = s.includes(' ') && !s.includes('T') ? s.replace(' ', 'T') : s;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/**
 * Apply the config's sort + limit to the loaded rows. Sorting is by the *first*
 * Y measure (the natural ordering for a chart); `none` keeps result order. The
 * limit caps the row count (`all` = no cap). Returns the windowed row subset.
 * 設定内のソート順と表示件数上限を、ロード済みの行データに適用する。
 * ソートは常に「最初のY測定値」を基準に行う（チャートとして自然な並び順のため）。
 * sort が 'none' の場合はクエリ結果の並び順をそのまま維持する。
 * limit は表示行数の上限を適用する（'all' の場合は上限なし）。
 * 適用後の行データ（ウィンドウ処理済みの部分集合）を返す。
 */
export function applySortLimit(rows: ReadonlyArray<ResultRow>, config: ChartConfig): ResultRow[] {
  // 元の配列を破壊しないようコピーしてから加工する。
  let view = rows.slice();
  const sortKey = config.yIndices[0];
  if (config.sort !== 'none' && sortKey !== undefined) {
    // asc なら +1、desc なら -1 の係数にして比較式を共通化する。
    const factor = config.sort === 'asc' ? 1 : -1;
    view = view
      // 元のインデックス i を保持しておき、安定ソート（同値時は元の順序維持）に使う。
      .map((row, i) => ({ row, i }))
      .sort((a, b) => {
        const av = toNumber(a.row[sortKey]);
        const bv = toNumber(b.row[sortKey]);
        // 数値化できない値（null）は末尾に寄せる。
        if (av === null && bv === null) return a.i - b.i;
        if (av === null) return 1;
        if (bv === null) return -1;
        const cmp = (av - bv) * factor;
        return cmp !== 0 ? cmp : a.i - b.i; // stable
      })
      .map(({ row }) => row);
  }
  // 'all' 以外は指定件数までスライスして上限を適用する。
  if (config.limit !== 'all') {
    view = view.slice(0, config.limit);
  }
  return view;
}

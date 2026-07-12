/**
 * チャート設定の契約。
 * ノートブックのセル（および将来の Dashboard widget）に紐づくチャート表示設定を
 * サーバーへ永続化するための zod スキーマを定義する。従来は web パッケージの
 * chartData.ts にローカル型として定義されクライアントメモリにのみ保持されていたが、
 * リロード後も設定を復元できるよう契約層へ昇格した。
 */
import { z } from 'zod';
import { MAX_CHART_SERIES } from './limits';

/** チャート種別。棒 / 折れ線 / タイムライン / 円 / 散布図の 5 種。 */
export const chartTypeSchema = z.enum(['bars', 'lines', 'timeline', 'pie', 'scatter']);
/** チャート種別の推論型。 */
export type ChartType = z.infer<typeof chartTypeSchema>;

/** 行のソート順。'none' は結果の並び順のまま、'asc'/'desc' は第一 Y 測定値基準。 */
export const chartSortOrderSchema = z.enum(['none', 'asc', 'desc']);
/** ソート順の推論型。 */
export type SortOrder = z.infer<typeof chartSortOrderSchema>;

/** UI 上で選択可能な表示件数の上限候補。'all' はロード済みの全行を表示する特別値。 */
export const CHART_LIMIT_OPTIONS = [5, 10, 25, 50, 100, 'all'] as const;

/** 表示件数上限のスキーマ（5 | 10 | 25 | 50 | 100 | 'all'）。 */
export const chartLimitSchema = z.union([
  z.literal(5),
  z.literal(10),
  z.literal(25),
  z.literal(50),
  z.literal(100),
  z.literal('all'),
]);
/** 表示件数上限の推論型。 */
export type LimitOption = z.infer<typeof chartLimitSchema>;

/**
 * セル単位のチャート設定。カラムはカラム名ではなく index（位置）で参照するため、
 * カラム名の変更があっても設定が壊れにくく、行データへのアクセスもポジショナルに
 * そのまま行える。yIndices は描画対象とする（数値）測定値の集合で、pie / scatter
 * では先頭の要素のみが主たる値として使われる。
 * 描画時には現在のカラム構成と突き合わせた補正（web 側 reconcileConfig）を通すため、
 * 保存値が古いカラム構成を指していても安全に扱える。
 */
export const chartConfigSchema = z.object({
  /** チャート種別。 */
  type: chartTypeSchema,
  /** X 軸に使うカラムの index。未選択の場合は null。 */
  xIndex: z.number().int().nonnegative().nullable(),
  /** Y 軸（測定値）に使うカラムの index の配列。複数選択で複数系列になる。 */
  yIndices: z.array(z.number().int().nonnegative()),
  /** 行のソート順。 */
  sort: chartSortOrderSchema,
  /** 表示行数の上限。'all' は上限なし。 */
  limit: chartLimitSchema,
  /** scatter 専用: 系列分け（カテゴリ）カラムの index。 */
  groupIndex: z.number().int().nonnegative().nullable().optional(),
  /** scatter 専用: 点サイズ（数値）カラムの index。 */
  sizeIndex: z.number().int().nonnegative().nullable().optional(),
});
/** チャート設定の推論型。 */
export type ChartConfig = z.infer<typeof chartConfigSchema>;

/** API 入力で系列配列を有界にしたチャート設定。 */
export const chartConfigInputSchema = chartConfigSchema.extend({
  yIndices: z.array(z.number().int().nonnegative()).max(MAX_CHART_SERIES),
});

import { z } from 'zod';
import { chartConfigSchema } from './chart';
import { isoTimestamp } from './common';
import { myPermissionSchema } from './share';

/**
 * Dashboard 機能（クエリ結果とチャートのパネルをグリッド配置する画面）の契約を
 * 定義するファイル。widget は保存済みクエリを参照する query 型と、Markdown を
 * 表示する text 型の 2 種。チャート設定は独立エンティティにせず widget へ
 * インラインで保持する（GitHub 同期の参照関係を増やさないため）。
 * パネルのデータ取得はクライアントが既存のクエリ実行 API（POST /api/queries）を
 * 呼ぶ方式であり、実行時の認可（datasource allowlist 等）はそちらで強制される。
 */

/** widget のグリッド上の位置とサイズ。react-grid-layout の x/y/w/h に対応する。 */
export const widgetPositionSchema = z.object({
  /** 左端からの列位置（0 始まり）。 */
  col: z.number().int().nonnegative(),
  /** 上端からの行位置（0 始まり）。 */
  row: z.number().int().nonnegative(),
  /** 幅（グリッド列数）。 */
  sizeX: z.number().int().positive(),
  /** 高さ（グリッド行数）。 */
  sizeY: z.number().int().positive(),
});
/** widget 位置の推論型。 */
export type WidgetPosition = z.infer<typeof widgetPositionSchema>;

/** query widget の表示形式。テーブル / チャート / counter（単一値の KPI 表示）。 */
export const widgetVizSchema = z.enum(['table', 'chart', 'counter']);
/** 表示形式の推論型。 */
export type WidgetViz = z.infer<typeof widgetVizSchema>;

/** counter 表示の設定。結果の先頭行から指定カラムの値を大きく表示する。 */
export const counterConfigSchema = z.object({
  /** 値として表示するカラムの index。 */
  columnIndex: z.number().int().nonnegative(),
  /** 値の下に表示するラベル（省略時はカラム名）。 */
  label: z.string().optional(),
});
/** counter 設定の推論型。 */
export type CounterConfig = z.infer<typeof counterConfigSchema>;

/** 保存済みクエリの結果を表示する widget。 */
export const queryWidgetSchema = z.object({
  /** widget の一意な id（dashboard 内で一意であればよい）。 */
  id: z.string().min(1),
  kind: z.literal('query'),
  /** グリッド上の位置とサイズ。 */
  position: widgetPositionSchema,
  /** 参照する保存済みクエリの id。表示時に参照先が無ければパネル単位でエラー表示する。 */
  savedQueryId: z.string().min(1),
  /** 表示形式。 */
  viz: widgetVizSchema,
  /** viz が 'chart' の場合のチャート設定（インライン保持）。 */
  chart: chartConfigSchema.optional(),
  /** viz が 'counter' の場合の counter 設定。 */
  counter: counterConfigSchema.optional(),
  /** widget に付ける任意の表示タイトル（省略時は保存クエリ名）。 */
  title: z.string().optional(),
});
/** query widget の推論型。 */
export type QueryWidget = z.infer<typeof queryWidgetSchema>;

/** Markdown テキストを表示する widget。 */
export const textWidgetSchema = z.object({
  /** widget の一意な id（dashboard 内で一意であればよい）。 */
  id: z.string().min(1),
  kind: z.literal('text'),
  /** グリッド上の位置とサイズ。 */
  position: widgetPositionSchema,
  /** 表示する Markdown テキスト。 */
  text: z.string(),
});
/** text widget の推論型。 */
export type TextWidget = z.infer<typeof textWidgetSchema>;

/** dashboard の widget（query 型と text 型の判別付き union）。 */
export const dashboardWidgetSchema = z.discriminatedUnion('kind', [
  queryWidgetSchema,
  textWidgetSchema,
]);
/** widget の推論型。 */
export type DashboardWidget = z.infer<typeof dashboardWidgetSchema>;

/** Dashboard 本体のスキーマ。 */
export const dashboardSchema = z.object({
  /** dashboard の一意な id。 */
  id: z.string().min(1),
  /** dashboard 名。 */
  name: z.string(),
  /** 説明文。 */
  description: z.string(),
  /** widget の集合。位置情報は各 widget の position が持つ。 */
  widgets: z.array(dashboardWidgetSchema),
  /** 作成日時。 */
  createdAt: isoTimestamp,
  /** 最終更新日時。 */
  updatedAt: isoTimestamp,
  /** 所有者 user id。共有経由で取得した場合に設定される。 */
  owner: z.string().optional(),
  /** 呼び出し元の effective permission (owner / edit / view)。 */
  myPermission: myPermissionSchema.optional(),
});
/** Dashboard 全体の推論型。 */
export type Dashboard = z.infer<typeof dashboardSchema>;

/** `GET /api/dashboards` の一覧表示用の軽量版。widget 本体を含まない。 */
export const dashboardListItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  /** widget 数（一覧のサマリ表示用）。 */
  widgetCount: z.number().int().nonnegative(),
  updatedAt: isoTimestamp,
  createdAt: isoTimestamp,
  /** 所有者 user id。共有経由で取得した場合に設定される。 */
  owner: z.string().optional(),
  /** 呼び出し元の effective permission (owner / edit / view)。 */
  myPermission: myPermissionSchema.optional(),
});
/** 一覧項目の推論型。 */
export type DashboardListItem = z.infer<typeof dashboardListItemSchema>;

/** `POST /api/dashboards` のリクエストボディ。widgets 省略時は空で作成される。 */
export const createDashboardRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  widgets: z.array(dashboardWidgetSchema).optional(),
});
/** 作成リクエストの推論型。 */
export type CreateDashboardRequest = z.infer<typeof createDashboardRequestSchema>;

/** `PUT /api/dashboards/:id` のリクエストボディ（可変フィールドの全置換）。 */
export const updateDashboardRequestSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  widgets: z.array(dashboardWidgetSchema),
});
/** 更新リクエストの推論型。 */
export type UpdateDashboardRequest = z.infer<typeof updateDashboardRequestSchema>;

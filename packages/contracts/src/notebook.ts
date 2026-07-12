import { z } from 'zod';
import { chartConfigInputSchema, chartConfigSchema } from './chart';
import { isoTimestamp } from './common';
import { myPermissionSchema } from './share';
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTEBOOK_CELLS,
  MAX_NOTEBOOK_VARIABLES,
  MAX_SQL_LENGTH,
  MAX_VARIABLE_OPTIONS,
} from './limits';

/**
 * Notebook model. Hue's `Notebook { snippets[] }` simplified to a
 * single `cells` array (tabs/cells double-holding removed per prior lesson).
 *
 * ノートブック（SQL / Markdown セルの集合）に関する契約を定義するファイル。
 * Hue の `Notebook { snippets[] }` を単純化し、単一の `cells` 配列で表現する
 * （タブとセルを二重に保持する設計は過去の教訓から排除した）。
 */

/**
 * Variable input widget type.
 * ノートブック変数の入力ウィジェット種別。UI 上でどの入力コンポーネントを
 * 表示するかを決める（テキスト欄、数値欄、日付ピッカー、チェックボックス、セレクトなど）。
 */
export const variableTypeSchema = z.enum([
  'text',
  'number',
  'date',
  'datetime-local',
  'checkbox',
  'select',
]);
/** 変数ウィジェット種別の推論型。 */
export type VariableType = z.infer<typeof variableTypeSchema>;

/**
 * An option for a 'select' variable.
 * 'select' 型変数における選択肢 1 件分のスキーマ。
 */
export const variableOptionSchema = z.object({
  // 選択肢の表示ラベル。
  label: z.string(),
  // 選択肢が選ばれたときに変数に代入される実際の値。
  value: z.string(),
});
/** 選択肢の推論型。 */
export type VariableOption = z.infer<typeof variableOptionSchema>;

// 変数のメタ情報（入力ウィジェットの見た目と振る舞いを決める）。
export const variableMetaSchema = z.object({
  // 入力ウィジェット種別。
  type: variableTypeSchema,
  // type が 'select' の場合の選択肢一覧。
  options: z.array(variableOptionSchema).optional(),
  // 入力欄に表示するプレースホルダー文字列。
  placeholder: z.string().optional(),
});
/** 変数メタ情報の推論型。 */
export type VariableMeta = z.infer<typeof variableMetaSchema>;

// ノートブック変数（SQL 文中で `${name}` のように参照できるプレースホルダー）1 件分のスキーマ。
export const variableSchema = z.object({
  // 変数名。
  name: z.string().min(1),
  // 現在の値（文字列として保持し、実行時に型に応じて解釈される）。
  value: z.string(),
  // 入力ウィジェットのメタ情報。
  meta: variableMetaSchema,
});
/** 変数の推論型。 */
export type Variable = z.infer<typeof variableSchema>;

/** セルの種類。'sql'（SQL 実行セル） / 'markdown'（説明文セル）。 */
export const cellKindSchema = z.enum(['sql', 'markdown']);
/** セル種類の推論型。 */
export type CellKind = z.infer<typeof cellKindSchema>;

/**
 * Summary of a cell's last execution, persisted with the notebook
 * (full result rows are NOT persisted).
 *
 * セルの直近の実行結果サマリ。ノートブックと一緒に永続化されるが、
 * 結果行そのものは永続化されない（再度実行すれば取得できるため）。
 */
export const cellResultMetaSchema = z.object({
  // 実行時の Trino クエリ id。
  trinoQueryId: z.string().optional(),
  // 実行の終端状態（文字列。厳密な QueryState との整合は呼び出し側の責務）。
  state: z.string().optional(),
  // 取得した行数。
  rowCount: z.number().int().nonnegative().optional(),
  // 実行にかかった時間（ミリ秒）。
  elapsedMs: z.number().int().nonnegative().optional(),
  // 失敗時のエラーメッセージ。
  errorMessage: z.string().optional(),
  // 実行日時。
  executedAt: isoTimestamp.optional(),
});
/** セル実行結果サマリの推論型。 */
export type CellResultMeta = z.infer<typeof cellResultMetaSchema>;

// ノートブックのセル 1 件分のスキーマ。
export const cellSchema = z.object({
  // セルの一意な id（ノートブック内で一意であればよい）。
  id: z.string().min(1),
  // セル種別（sql / markdown）。
  kind: cellKindSchema,
  // セルの本文（SQL 文または Markdown テキスト）。
  source: z.string(),
  // セルに付けられた任意の表示名。
  name: z.string().optional(),
  // セルが折りたたみ表示されているかどうか。
  collapsed: z.boolean().optional(),
  // 直近の実行結果サマリ（未実行の場合は省略）。
  resultMeta: cellResultMetaSchema.optional(),
  // セルのチャート表示設定（一度もチャートを操作していない場合は省略）。
  chart: chartConfigSchema.optional(),
});
/** セルの推論型。 */
export type Cell = z.infer<typeof cellSchema>;

// ノートブックの既定実行コンテキスト（どのカタログ/スキーマを対象にするか）。
export const notebookContextSchema = z.object({
  catalog: z.string().optional(),
  schema: z.string().optional(),
});
/** ノートブックコンテキストの推論型。 */
export type NotebookContext = z.infer<typeof notebookContextSchema>;

// ノートブック本体のスキーマ。
export const notebookSchema = z.object({
  // ノートブックの一意な id。
  id: z.string().min(1),
  // ノートブック名。
  name: z.string(),
  // ノートブックの説明文。
  description: z.string(),
  // セルの並び。
  cells: z.array(cellSchema),
  // 変数一覧。
  variables: z.array(variableSchema),
  // 既定の実行コンテキスト。
  context: notebookContextSchema,
  // 作成日時。
  createdAt: isoTimestamp,
  // 最終更新日時。
  updatedAt: isoTimestamp,
  // 全置換更新の競合検出に使う単調増加revision。
  revision: z.number().int().nonnegative(),
  /** 所有者 user id。共有経由で取得した場合に設定される。 */
  owner: z.string().optional(),
  /** 呼び出し元の effective permission (owner / edit / view)。 */
  myPermission: myPermissionSchema.optional(),
});
/** ノートブック全体の推論型。 */
export type Notebook = z.infer<typeof notebookSchema>;

/**
 * Notebook list item (lightweight, no cells) for `GET /api/notebooks`.
 * `GET /api/notebooks` の一覧表示用の軽量版。セル本文などの重いデータを含まない。
 */
export const notebookListItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  updatedAt: isoTimestamp,
  createdAt: isoTimestamp,
  /** 所有者 user id。共有経由で取得した場合に設定される。 */
  owner: z.string().optional(),
  /** 呼び出し元の effective permission (owner / edit / view)。 */
  myPermission: myPermissionSchema.optional(),
});
/** ノートブック一覧項目の推論型。 */
export type NotebookListItem = z.infer<typeof notebookListItemSchema>;

// API 入力だけに適用する有界版。既存の保存データを読む response schema は
// 互換性のため変更せず、新規または更新リクエストの増大だけを止める。
const variableOptionInputSchema = variableOptionSchema.extend({
  label: z.string().max(MAX_NAME_LENGTH),
  value: z.string().max(MAX_DESCRIPTION_LENGTH),
});
const variableInputSchema = variableSchema.extend({
  name: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
  value: z.string().max(MAX_DESCRIPTION_LENGTH),
  meta: variableMetaSchema.extend({
    options: z.array(variableOptionInputSchema).max(MAX_VARIABLE_OPTIONS).optional(),
    placeholder: z.string().max(MAX_NAME_LENGTH).optional(),
  }),
});
const cellInputSchema = cellSchema.extend({
  id: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
  source: z.string().max(MAX_SQL_LENGTH),
  name: z.string().max(MAX_NAME_LENGTH).optional(),
  resultMeta: cellResultMetaSchema
    .extend({
      trinoQueryId: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
      state: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
      errorMessage: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
    })
    .optional(),
  chart: chartConfigInputSchema.optional(),
});
const notebookContextInputSchema = notebookContextSchema.extend({
  catalog: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
  schema: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
});

/**
 * Request body for `POST /api/notebooks`.
 * `POST /api/notebooks`（新規作成）のリクエストボディ。cells / variables / context は
 * 省略可能で、省略時は空のノートブックとして作成される。
 */
export const createNotebookRequestSchema = z.object({
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  description: z.string().max(MAX_DESCRIPTION_LENGTH).optional(),
  cells: z.array(cellInputSchema).max(MAX_NOTEBOOK_CELLS).optional(),
  variables: z.array(variableInputSchema).max(MAX_NOTEBOOK_VARIABLES).optional(),
  context: notebookContextInputSchema.optional(),
});
/** ノートブック作成リクエストの推論型。 */
export type CreateNotebookRequest = z.infer<typeof createNotebookRequestSchema>;

/**
 * Request body for `PUT /api/notebooks/:id` (full replace of mutable fields).
 * `PUT /api/notebooks/:id` のリクエストボディ。可変フィールドを全置換する
 * （PATCH ではなく PUT なので、すべてのフィールドを毎回渡す必要がある）。
 */
export const updateNotebookRequestSchema = z.object({
  revision: z.number().int().nonnegative(),
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  description: z.string().max(MAX_DESCRIPTION_LENGTH),
  cells: z.array(cellInputSchema).max(MAX_NOTEBOOK_CELLS),
  variables: z.array(variableInputSchema).max(MAX_NOTEBOOK_VARIABLES),
  context: notebookContextInputSchema,
});
/** ノートブック更新リクエストの推論型。 */
export type UpdateNotebookRequest = z.infer<typeof updateNotebookRequestSchema>;

/**
 * API から受け付ける保存資源とクエリ文の上限。
 * HTTP body 全体の上限に加え、繰り返し要素と個別文字列もここで有界にする。
 */

/** SQL 文 1 件の最大文字数。 */
export const MAX_SQL_LENGTH = 200_000;

/** 名前や識別子として受け付ける最大文字数。 */
export const MAX_NAME_LENGTH = 200;
export const MAX_IDENTIFIER_LENGTH = 256;

/** 説明文とエラーメッセージの最大文字数。 */
export const MAX_DESCRIPTION_LENGTH = 20_000;

/** Notebook の構造上限。 */
export const MAX_NOTEBOOK_CELLS = 200;
export const MAX_NOTEBOOK_VARIABLES = 100;
export const MAX_VARIABLE_OPTIONS = 100;

/** Dashboard の widget 数上限。 */
export const MAX_DASHBOARD_WIDGETS = 200;

/** 1チャートで選択できる系列数の上限。 */
export const MAX_CHART_SERIES = 100;

/** クエリ session property の個数と各要素の上限。 */
export const MAX_SESSION_PROPERTIES = 100;
export const MAX_SESSION_PROPERTY_VALUE_LENGTH = 4_096;

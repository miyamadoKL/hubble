/**
 * Alert 機能（AlertsPanel / AlertFormModal / AlertStateBadge）で共有する、UI を
 * 持たない純粋関数集。`scheduleFormat.ts` の Alert 版。selector（結果行から監視値を
 * 取り出す方法）と state（実行時状態）の表示ラベルを、フォーム、一覧、バッジの
 * どれからも同じ変換で得られるようにする。
 */
import type { AlertSelector, AlertState } from '@hubble/contracts';
import { t } from '../../i18n/t';
import { alertMessages } from '../../i18n/messages/alert';
import type { Locale } from '../../i18n/locale';

// selector の契約値を辞書のキーへマッピングするテーブル。<option value={item}> や
// 一覧表示には契約値（first/max/min）をそのまま使うが、画面表示だけを翻訳する。
const SELECTOR_LABEL_KEY = {
  first: 'selectorFirst',
  max: 'selectorMax',
  min: 'selectorMin',
} as const satisfies Record<AlertSelector, keyof typeof alertMessages>;

/**
 * selector の契約値から、画面表示用の翻訳済みラベルを求める。
 * `locale` 省略時は 'en'（既存呼び出し元との後方互換用のデフォルト値）。
 */
export function alertSelectorLabel(selector: AlertSelector, locale: Locale = 'en'): string {
  return t(alertMessages, SELECTOR_LABEL_KEY[selector], locale);
}

// AlertState の各値を辞書のキーへマッピングするテーブル。
const STATE_LABEL_KEY = {
  ok: 'stateOk',
  triggered: 'stateTriggered',
  unknown: 'stateUnknown',
} as const satisfies Record<AlertState, keyof typeof alertMessages>;

/**
 * AlertState の契約値から、画面表示用の翻訳済みラベルを求める（AlertStateBadge の
 * 表示、AlertsPanel の評価完了トースト等で共通利用する）。
 * `locale` 省略時は 'en'（既存呼び出し元との後方互換用のデフォルト値）。
 */
export function alertStateLabel(state: AlertState, locale: Locale = 'en'): string {
  return t(alertMessages, STATE_LABEL_KEY[state], locale);
}

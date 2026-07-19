/**
 * クエリの実行状態(QueryState)の表示ラベルを翻訳する、UI を持たない純粋関数。
 * `alertFormat.ts`(AlertState 版)と同じパターンで、契約値(queued/running/
 * finished/failed/canceled)から画面表示用のロケール別ラベルへ変換する。
 * HistoryPanel と OperationsPanel の両方が同じ変換を必要とするためここに切り出す。
 */
import type { QueryState } from '@hubble/contracts';
import { t } from '../../i18n/t';
import { panelsMessages } from '../../i18n/messages/panels';
import type { Locale } from '../../i18n/locale';

// QueryState の契約値を辞書のキーへマッピングするテーブル。
const STATE_LABEL_KEY = {
  queued: 'queryStateQueued',
  running: 'queryStateRunning',
  finished: 'queryStateFinished',
  failed: 'queryStateFailed',
  canceled: 'queryStateCanceled',
} as const satisfies Record<QueryState, keyof typeof panelsMessages>;

/**
 * QueryState の契約値から、画面表示用の翻訳済みラベルを求める
 * (QueryStateBadge の表示で共通利用する)。
 */
export function queryStateLabel(state: QueryState, locale: Locale): string {
  return t(panelsMessages, STATE_LABEL_KEY[state], locale);
}

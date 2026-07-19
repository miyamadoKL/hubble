/**
 * クエリの実行状態(QueryState)を共通バッジで表示する、i18n 対応版のラッパー。
 * `AlertStateBadge.tsx` と同じパターン: 契約値からトーンと表示ラベルを決め、
 * ラベルだけをロケールに応じて翻訳して `StatusBadge` へ渡す。`StatusBadge` 自身は
 * ドメイン語彙(QueryState)を知らず描画のみを行う。
 *
 * `common/StateBadge.tsx` は既存の互換 API として維持し(PR #99 の方針どおり、
 * ラベルの翻訳は呼び出し側の責務)、契約値をそのまま大文字表示する。i18n 対応が
 * 必要な HistoryPanel/OperationsPanel はこちらを使う(StatsStrip.tsx は本バッチの
 * スコープ外のため StateBadge のまま)。
 */
import type { QueryState } from '@hubble/contracts';
import { StatusBadge, type StatusBadgeTone } from '../common/StatusBadge';
import { useLocale } from '../../i18n/locale';
import { queryStateLabel } from './queryStateFormat';

// QueryState の契約値からバッジのトーン(色)を決めるテーブル。
// common/StateBadge.tsx の STATE_TONE と同じ対応関係(トーンは契約値に紐づく描画上の
// 属性であり、翻訳対象ではないため辞書には持たない)。
const STATE_TONE: Record<QueryState, StatusBadgeTone> = {
  queued: 'neutral',
  running: 'running',
  finished: 'success',
  failed: 'error',
  canceled: 'neutral',
};

/**
 * @param state 表示するクエリの実行状態。
 * @param className バッジ本体に追加するクラス。
 */
export function QueryStateBadge({ state, className }: { state: QueryState; className?: string }) {
  const { locale } = useLocale();
  return (
    <StatusBadge
      tone={STATE_TONE[state]}
      label={queryStateLabel(state, locale)}
      className={className}
    />
  );
}

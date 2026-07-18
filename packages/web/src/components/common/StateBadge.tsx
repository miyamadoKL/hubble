/**
 * クエリの実行状態を共通状態バッジで表示する。
 * 履歴一覧や統計ストリップで利用し、QueryStateからトーンと大文字ラベルを決める。
 * QueryStateからtone/labelへの変換はこのファイルの責務で、StatusBadge自体は
 * ドメイン語彙（QueryState）を知らず描画のみを行う。
 */
import type { QueryState } from '@hubble/contracts';
import { StatusBadge, type StatusBadgeTone } from './StatusBadge';

const STATE_TONE: Record<QueryState, StatusBadgeTone> = {
  queued: 'neutral',
  running: 'running',
  finished: 'success',
  failed: 'error',
  canceled: 'neutral',
};

const STATE_LABEL: Record<QueryState, string> = {
  queued: 'QUEUED',
  running: 'RUNNING',
  finished: 'FINISHED',
  failed: 'FAILED',
  canceled: 'CANCELED',
};

/**
 * @param state 表示するクエリの実行状態。
 * @param className バッジ本体に追加するクラス。
 * @param dot 先頭ドットの表示（デフォルトはtrue、running時は点滅）。
 */
export function StateBadge({
  state,
  className,
  dot = true,
}: {
  state: QueryState;
  className?: string;
  dot?: boolean;
}) {
  return (
    <StatusBadge
      tone={STATE_TONE[state]}
      label={STATE_LABEL[state]}
      className={className}
      dot={dot}
    />
  );
}

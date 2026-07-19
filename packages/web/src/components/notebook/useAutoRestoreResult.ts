/**
 * useAutoRestoreResult.ts
 *
 * リロード直後など、このセッションではまだ実行していないが永続化された前回結果
 * （resultMeta.queryId、サーバー側に TTL 付きで残る）があるセルを、ユーザー操作
 * なしで自動的に復元する hook（指摘4: セル右下の別の「再実行」ボタンは廃止し、
 * 実行操作はツールバーの実行ボタンへ統一する）。
 *
 * SqlCell.tsx から切り出してあるのは、ViewportCell の遅延マウント/アンマウント
 * （視界外→再進入）を跨いで「cellId + queryId の組み合わせごとに1回だけ試行する」
 * という挙動を、SqlCell 本体（Monaco 依存で重く、単体テストのマウントコストが
 * 高い）を経由せずに単体テストできるようにするため。試行済みかどうかの記録自体は
 * execution ストア側のモジュールレベル Map（hasAttemptedRestore/
 * markRestoreAttempted）で、マウントのライフサイクルを跨いで保持する。
 */
import { useEffect } from 'react';
import { executionActions, hasAttemptedRestore, markRestoreAttempted } from '../../execution';

/**
 * 永続化結果の自動復元を1回だけ試みる。
 *
 * @param cellId - 対象セルの id。
 * @param hasExec - このセッションで既に実行状態（exec）を持っているか。
 *   true なら（今まさに実行中/実行済みのため）何もしない。
 * @param queryId - 永続化結果を指すアプリ側クエリ id（resultMeta.queryId）。
 *   undefined なら（永続化結果がないため）何もしない。
 */
export function useAutoRestoreResult(
  cellId: string,
  hasExec: boolean,
  queryId: string | undefined,
): void {
  useEffect(() => {
    if (hasExec || !queryId) return;
    if (hasAttemptedRestore(cellId, queryId)) return;
    markRestoreAttempted(cellId, queryId);
    void executionActions().restoreCell(cellId, queryId);
  }, [cellId, hasExec, queryId]);
}

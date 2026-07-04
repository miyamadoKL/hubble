/**
 * CellFrame.tsx
 *
 * ノートブックの各セル（SQL / Markdown）を包む共通コンテナコンポーネント。
 * セル左端に実行状態を示す縦の「ガター（needle）」を描画し、状態に応じて
 * 色や点滅アニメーションを切り替える。セル本体の中身（children）は呼び出し元
 * （NotebookView / SqlCell / MarkdownCell 等）が渡す。
 */
import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';

/**
 * Cell container with the signature left status gutter. A thin vertical bar reflects the
 * cell's last execution state; it brightens on hover.
 */

/**
 * セルの実行状態を表す型。
 * - idle: 未実行（一度も実行していない）
 * - queued: 実行キュー待ち
 * - running: 実行中
 * - finished: 成功して完了
 * - failed: エラーで失敗
 */
export type CellStatus = 'idle' | 'queued' | 'running' | 'finished' | 'failed';

// 各実行状態に対応するガター（左端の縦バー）の背景色クラス。
const gutterColor: Record<CellStatus, string> = {
  idle: 'bg-border-base',
  queued: 'bg-ink-subtle',
  running: 'bg-running',
  finished: 'bg-success',
  failed: 'bg-error',
};

/**
 * CellFrame の props。
 * @property status - このセルの現在の実行状態（ガターの色とアニメーションに反映される）。
 * @property children - セル本体として描画する内容（SQL エディタや Markdown 表示など）。
 * @property className - 外側の div に追加で適用する任意の CSS クラス。
 */
interface CellFrameProps {
  status: CellStatus;
  children: ReactNode;
  className?: string;
}

/**
 * セルの見た目上の枠（カード）を提供する共通コンポーネント。
 * 左端に実行状態を示す縦のガターを描画し、その右側に children を配置する。
 * @param status - ガターの色とアニメーションを決める実行状態。
 * @param children - 枠内に描画するセル本体。
 * @param className - 追加の CSS クラス（ドラッグ中の半透明化など、呼び出し元から指定可能）。
 */
export function CellFrame({ status, children, className }: CellFrameProps) {
  return (
    <div
      className={cn(
        'group/cell relative overflow-hidden rounded-lg border border-border-base bg-surface-raised shadow-sm',
        'transition-colors focus-within:border-border-strong',
        className,
      )}
    >
      {/* Status gutter — the instrument's "needle" for this cell. */}
      {/* 実行状態を示すガター。aria-hidden で装飾要素としてスクリーンリーダーからは除外し、
          status が 'running' のときのみパルスアニメーションを付与する。 */}
      <span
        aria-hidden
        className={cn(
          'absolute top-0 left-0 h-full w-1 transition-colors',
          gutterColor[status],
          status === 'running' && 'animate-pulse',
        )}
      />
      {/* ガターの幅ぶん左にパディングを取った本体領域。children をそのまま描画する。 */}
      <div className="pl-1">{children}</div>
    </div>
  );
}

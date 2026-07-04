// ProgressBar コンポーネント
// クエリ実行中の進捗状況を示す、細い横長のプログレスバー。
// 進捗率（0〜100）が分かっている場合は確定的（determinate）に幅を伸ばし、
// 分からない場合（queued 状態など）は不確定（indeterminate）アニメーションで
// 「実行中であること」だけを示す。
import { cn } from '../../utils/cn';

/** ProgressBar の props */
interface ProgressBarProps {
  /** 0–100; omit for an indeterminate bar. */
  // 進捗率（0〜100）。undefined の場合は不確定モードのバーを表示する。
  value?: number;
  // 外側から追加のクラス名を渡すためのフィールド（レイアウト調整用）。
  className?: string;
}

/**
 * Thin query-progress bar. Determinate fills with the
 * running color; indeterminate animates a sweeping segment.
 */
/**
 * クエリの進捗を表す薄いバー。
 * value が指定されていれば実際の進捗率に応じてバーの幅を伸ばし（確定モード）、
 * value が undefined（例: queued 状態で進捗が不明）の場合は
 * 一定幅のセグメントが左右に流れるアニメーションを表示する（不確定モード）。
 */
export function ProgressBar({ value, className }: ProgressBarProps) {
  // value が未指定なら不確定モードと判定する。
  const indeterminate = value === undefined;
  return (
    <div
      className={cn('h-0.5 w-full overflow-hidden bg-running-soft', className)}
      role="progressbar"
      // 不確定モードのときは aria-valuenow を省略し、支援技術に「割合不明」と伝える。
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {indeterminate ? (
        // 不確定モード: 幅1/3のセグメントが左右にスイープするアニメーションバー。
        <div className="h-full w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite] bg-running" />
      ) : (
        // 確定モード: 進捗率に応じて幅を伸ばす（0〜100の範囲にクランプする）。
        <div
          className="h-full bg-running transition-[width] duration-150"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      )}
    </div>
  );
}

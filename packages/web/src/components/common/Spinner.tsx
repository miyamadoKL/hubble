/**
 * 読み込み中や実行中などの不確定な処理状態を示すスピナーコンポーネント。
 * lucide-react の Loader2 アイコンを回転アニメーションさせて表示する。
 */
import { Loader2 } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * Spinner コンポーネントの props。
 */
interface SpinnerProps {
  /** アイコンのサイズ（px単位）。未指定時は16。 */
  size?: number;
  /** 追加で付与する className。 */
  className?: string;
  /** スクリーンリーダー向けの aria-label。未指定時は 'Loading'。 */
  label?: string;
}

/**
 * 進行中であることを示す不確定（indeterminate）スピナー。
 * "running" のセマンティックカラーを使用し、回転アニメーション
 * (`animate-spin`) で処理中であることを視覚的に表現する。
 *
 * @param size - アイコンのサイズ（px）。デフォルトは16。
 * @param className - 追加のクラス名。
 * @param label - aria-label に設定する説明文。デフォルトは 'Loading'。
 */
export function Spinner({ size = 16, className, label = 'Loading' }: SpinnerProps) {
  return (
    <Loader2
      size={size}
      strokeWidth={2}
      aria-label={label}
      className={cn('animate-spin text-running', className)}
    />
  );
}

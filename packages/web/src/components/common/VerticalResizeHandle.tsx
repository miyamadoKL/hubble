/**
 * VerticalResizeHandle.tsx
 *
 * 縦方向（高さ）のリサイズハンドルの共通見た目/挙動。結果表示域（ResultGrid）と
 * SQL エディター（SqlEditor）の両方の高さハンドルがこのコンポーネントを使う。
 * PR #119 では「通常時ほぼ不可視」（h-px の透明バー）だったためユーザーが発見
 * できず、ハンドル自体を常時見えるグリップバーへ変更した: 全幅で高さ約10pxの
 * ゾーンの中央に、幅32px程度の丸めたグリップを常時表示し、hover/focus/ドラッグ中は
 * アクセントカラーへ強調する。
 *
 * role="separator" + aria-orientation="horizontal" でスクリーンリーダーに伝え、
 * pointer ドラッグ、ダブルクリックでの自動サイズ復帰、上下矢印キーでの微調整
 * （16px刻み、preventDefault 済み）に対応する。
 */
import { cn } from '../../utils/cn';

/** VerticalResizeHandle コンポーネントの props。 */
export interface VerticalResizeHandleProps {
  /** アクセシビリティ用のラベル（role="separator" の aria-label）。 */
  ariaLabel: string;
  /** 現在の高さ（px）。aria-valuenow にそのまま渡す。 */
  valueNow: number;
  /** 高さの下限（px）。aria-valuemin に渡す。 */
  valueMin: number;
  /** 高さの上限（px）。aria-valuemax に渡す。 */
  valueMax: number;
  /** ドラッグ開始（pointerdown）時のハンドラー。 */
  onPointerDown: (event: React.PointerEvent) => void;
  /** ダブルクリック時のハンドラー（自動サイズへの復帰に使う想定）。 */
  onDoubleClick: () => void;
  /**
   * 上下矢印キーによる高さ調整。呼び出し側は現在値へ deltaPx を加算した値を
   * 適用すること（このコンポーネントは preventDefault のみ行い、値の計算はしない）。
   */
  onAdjust: (deltaPx: number) => void;
  /** ルート要素に付与する追加の Tailwind クラス（境界線の位置調整など）。 */
  className?: string;
}

// 矢印キー1回あたりの調整幅（px）。ResultGrid の既存実装と揃える。
const ARROW_STEP_PX = 16;

/**
 * 縦方向リサイズハンドル本体。常時視認できるグリップバーを描画し、
 * pointer ドラッグ / ダブルクリック / キーボード操作をすべて呼び出し側へ委譲する。
 */
export function VerticalResizeHandle({
  ariaLabel,
  valueNow,
  valueMin,
  valueMax,
  onPointerDown,
  onDoubleClick,
  onAdjust,
  className,
}: VerticalResizeHandleProps) {
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={ariaLabel}
      aria-valuenow={valueNow}
      aria-valuemin={valueMin}
      aria-valuemax={valueMax}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
      onKeyDown={(e) => {
        // ページの矢印キースクロールと同時に発生しないよう、処理した矢印キーは
        // 既定動作を必ず止める。
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onAdjust(-ARROW_STEP_PX);
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          onAdjust(ARROW_STEP_PX);
        }
      }}
      className={cn(
        'group flex h-2.5 shrink-0 cursor-row-resize touch-none items-center justify-center',
        'border-b border-border-subtle bg-surface-base transition-colors hover:bg-surface-raised',
        'focus-visible:outline-none',
        className,
      )}
    >
      {/* 常時表示のグリップ本体。hover/focus/ドラッグ中はアクセントカラーへ強調する。 */}
      <span className="h-1 w-8 rounded-full bg-border-base transition-colors group-hover:bg-accent group-focus-visible:bg-accent" />
    </div>
  );
}

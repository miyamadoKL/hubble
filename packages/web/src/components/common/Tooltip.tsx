/**
 * ホバー/フォーカス時に説明ラベルを表示する軽量なツールチップコンポーネントを
 * 提供するモジュール。ポータルを使わず、ローカルな state のみで開閉を管理する。
 */
import { useId, useState, type ReactNode } from 'react';
import { cn } from '../../utils/cn';

/** ツールチップを表示する方向。 */
export type TooltipSide = 'top' | 'bottom' | 'left' | 'right';

/**
 * Tooltip コンポーネントの props。
 */
interface TooltipProps {
  /** ツールチップ内に表示する説明内容。 */
  label: ReactNode;
  /** ツールチップの対象となる要素（トリガー）。 */
  children: ReactNode;
  /** ツールチップを表示する方向。デフォルトは 'bottom'。 */
  side?: TooltipSide;
}

// side ごとに、トリガー要素に対するツールチップの位置決めクラスを定義
const sideClasses: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
};

/**
 * Lightweight tooltip. Shown on hover/focus via local state (no portal needed
 * for the shell). 150ms fade aligns with the motion budget (design.md §6).
 *
 * 軽量なツールチップ。ホバーまたはフォーカス時にローカル state (`open`) を
 * 切り替えて表示する（シェル用途のためポータルは使用しない）。
 * 150msのフェードでモーションバジェットに合わせている。
 *
 * @param label - ツールチップ内に表示する説明。
 * @param children - ツールチップを紐づける対象要素。
 * @param side - 表示位置（top/bottom/left/right）。デフォルトは 'bottom'。
 */
export function Tooltip({ label, children, side = 'bottom' }: TooltipProps) {
  // ツールチップの表示/非表示を管理する state
  const [open, setOpen] = useState(false);
  // aria-describedby に使う一意なID（アクセシビリティ用）
  const id = useId();
  return (
    <span
      className="relative inline-flex"
      // マウスホバー・フォーカスの開始/終了に応じて open を切り替える
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {/* トリガーとなる子要素。表示中のみ aria-describedby でツールチップに関連付ける */}
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      {/* ツールチップ本体。open の値に応じて opacity を切り替えてフェード表示する */}
      <span
        id={id}
        role="tooltip"
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-sm border border-border-strong',
          'bg-surface-overlay px-2 py-1 text-2xs font-medium text-ink-base shadow-md',
          'transition-opacity duration-150',
          sideClasses[side],
          open ? 'opacity-100' : 'opacity-0',
        )}
      >
        {label}
      </span>
    </span>
  );
}

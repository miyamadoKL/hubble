/**
 * アイコンのみを表示するボタンコンポーネント。
 *
 * ラベルはボタン内のテキストとしては表示せず、アクセシビリティ用の aria-label
 * および Tooltip のテキストとして使用する。variant、size、active（選択状態）を
 * 組み合わせて見た目を切り替えられる。
 */
import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';
import { Tooltip } from './Tooltip';

/** IconButton の見た目のバリエーション（default: 標準, ghost: 枠なし, accent: 強調, danger: 危険操作）。 */
export type IconButtonVariant = 'default' | 'ghost' | 'accent' | 'danger';
/** IconButton のサイズ（sm: 小, md: 中）。 */
export type IconButtonSize = 'sm' | 'md';

/** IconButton コンポーネントに渡す props。 */
interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** 表示する lucide-react のアイコン。 */
  icon: LucideIcon;
  /** アクセシビリティ用のラベル文字列。Tooltip のテキストとしても使用される。 */
  label: string;
  /** ボタンの見た目のバリエーション。未指定時は 'ghost'。 */
  variant?: IconButtonVariant;
  /** ボタンのサイズ。未指定時は 'md'。 */
  size?: IconButtonSize;
  /** トグルボタンなどで選択中の状態を表す場合は true。 */
  active?: boolean;
  /** ツールチップの表示を抑制したい場合は false にする（別の Tooltip の中にネストする場合など）。 */
  tooltip?: boolean;
}

// すべてのバリエーションとサイズに共通する基本スタイル（枠線、フォーカスリング、disabled 時の見た目など）。
const base =
  'inline-flex items-center justify-center rounded-md border transition-colors duration-100 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

// variant ごとの配色（枠線、背景、文字色、hover 時の色）定義。
const variants: Record<IconButtonVariant, string> = {
  default:
    'border-border-base bg-surface-raised text-ink-muted hover:text-ink-strong hover:bg-surface-sunken',
  ghost:
    'border-transparent bg-transparent text-ink-muted hover:text-ink-strong hover:bg-surface-sunken',
  accent: 'border-accent bg-accent text-accent-contrast hover:bg-accent-hover',
  danger: 'border-transparent bg-transparent text-ink-muted hover:text-error hover:bg-error-soft',
};

// active（選択中）の状態のときに、variant による配色よりも優先して適用するスタイル。
const activeCls = 'border-accent/40 bg-accent-soft text-accent';

// size ごとのボタンの寸法とアイコンサイズの定義。
const sizes: Record<IconButtonSize, { box: string; icon: number }> = {
  sm: { box: 'h-6 w-6', icon: 14 },
  md: { box: 'h-8 w-8', icon: 16 },
};

/**
 * アイコンボタンを描画する。
 *
 * active が true の場合は variant による配色よりも activeCls を優先して適用する。
 * tooltip が true（デフォルト）の場合は Tooltip コンポーネントでボタンをラップし、
 * label をツールチップとして表示する。tooltip が false の場合はボタンをそのまま返す。
 *
 * @param props - IconButtonProps（icon, label, variant, size, active, tooltip, および標準の button 属性）
 */
export function IconButton({
  icon: Icon,
  label,
  variant = 'ghost',
  size = 'md',
  active = false,
  tooltip = true,
  className,
  ...rest
}: IconButtonProps) {
  // size に応じたボタン/アイコンの寸法を取得する。
  const dims = sizes[size];
  // ボタン本体の要素。active かどうかで配色を切り替える。
  const button = (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active || undefined}
      className={cn(base, active ? activeCls : variants[variant], dims.box, className)}
      {...rest}
    >
      <Icon size={dims.icon} strokeWidth={1.75} />
    </button>
  );
  // tooltip が無効な場合は、Tooltip でラップせずにボタンをそのまま返す。
  if (!tooltip) return button;
  // それ以外の場合は Tooltip でラップし、label をツールチップテキストとして表示する。
  return <Tooltip label={label}>{button}</Tooltip>;
}

/**
 * 汎用ボタンコンポーネント。
 *
 * variant（見た目のバリエーション）と size（サイズ）を組み合わせてスタイルを
 * 切り替えられる、アプリ全体で共通利用されるボタン UI を提供する。
 * lucide-react のアイコンをラベルの前後どちらにも配置できる。
 */
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

/** Button の見た目のバリエーション（primary: 強調, default: 標準, ghost: 枠なし, danger: 危険操作）。 */
export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';
/** Button のサイズ（sm: 小, md: 中）。 */
export type ButtonSize = 'sm' | 'md';

/** Button コンポーネントに渡す props。標準の button 要素の属性に加え、見た目とアイコンの制御用オプションを持つ。 */
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** ボタンの見た目のバリエーション。未指定時は 'default'。 */
  variant?: ButtonVariant;
  /** ボタンのサイズ。未指定時は 'md'。 */
  size?: ButtonSize;
  /** ラベルと一緒に表示する lucide-react のアイコンコンポーネント。 */
  icon?: LucideIcon;
  /** Place the icon after the label instead of before. */
  /** アイコンをラベルの後ろに配置したい場合は true にする（デフォルトは前）。 */
  iconAfter?: boolean;
  /** ボタン内に表示する子要素（通常はラベルテキスト）。 */
  children?: ReactNode;
}

// すべてのバリエーションとサイズに共通して適用される基本スタイル
// （枠線、フォントの太さ、フォーカスリング、disabled 時の見た目など）。
const base =
  'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium ' +
  'whitespace-nowrap select-none transition-colors duration-100 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

// variant ごとの配色（枠線、背景、文字色、hover/active 時の色）定義。
const variants: Record<ButtonVariant, string> = {
  // Accent reserved for primary action (Run) — design.md §6.
  // アクセントカラーは「実行」など主要アクションを表す primary バリエーションにのみ使用する。
  primary:
    'border-accent bg-accent text-accent-contrast hover:bg-accent-hover active:bg-accent-active',
  default:
    'border-border-base bg-surface-raised text-ink-base hover:bg-surface-sunken hover:text-ink-strong',
  ghost: 'border-transparent bg-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
  danger: 'border-error/40 bg-error-soft text-error hover:border-error',
};

// size ごとの高さ、横方向の余白、フォントサイズの定義。
const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-3 text-sm',
};

/**
 * ボタンを描画する。
 *
 * props で受け取った variant / size に応じたスタイルを合成して <button> に適用し、
 * icon が指定されていれば iconAfter の値に応じてアイコンをラベルの前または後ろに
 * 配置する。それ以外の props（onClick など）はそのまま <button> 要素にスプレッドされる。
 *
 * @param props - ButtonProps（variant, size, icon, iconAfter, children, および標準の button 属性）
 */
export function Button({
  variant = 'default',
  size = 'md',
  icon: Icon,
  iconAfter = false,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  // icon prop が指定されていればアイコン要素を生成する。サイズはボタンサイズに応じて切り替える。
  const iconNode = Icon ? <Icon size={size === 'sm' ? 14 : 15} strokeWidth={1.75} /> : null;
  return (
    <button type={type} className={cn(base, variants[variant], sizes[size], className)} {...rest}>
      {/* iconAfter が false（デフォルト）の場合は、アイコンをラベルより先に表示する */}
      {!iconAfter && iconNode}
      {children}
      {/* iconAfter が true の場合は、アイコンをラベルの後に表示する */}
      {iconAfter && iconNode}
    </button>
  );
}

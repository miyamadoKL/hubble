import type { ButtonHTMLAttributes, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

export type ButtonVariant = 'primary' | 'default' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: LucideIcon;
  /** Place the icon after the label instead of before. */
  iconAfter?: boolean;
  children?: ReactNode;
}

const base =
  'inline-flex items-center justify-center gap-1.5 rounded-md border font-medium ' +
  'whitespace-nowrap select-none transition-colors duration-100 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-50';

const variants: Record<ButtonVariant, string> = {
  // Accent reserved for primary action (Run) — design.md §6.
  primary:
    'border-accent bg-accent text-accent-contrast hover:bg-accent-hover active:bg-accent-active',
  default:
    'border-border-base bg-surface-raised text-ink-base hover:bg-surface-sunken hover:text-ink-strong',
  ghost: 'border-transparent bg-transparent text-ink-muted hover:bg-surface-sunken hover:text-ink-strong',
  danger: 'border-error/40 bg-error-soft text-error hover:border-error',
};

const sizes: Record<ButtonSize, string> = {
  sm: 'h-7 px-2 text-xs',
  md: 'h-8 px-3 text-sm',
};

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
  const iconNode = Icon ? <Icon size={size === 'sm' ? 14 : 15} strokeWidth={1.75} /> : null;
  return (
    <button type={type} className={cn(base, variants[variant], sizes[size], className)} {...rest}>
      {!iconAfter && iconNode}
      {children}
      {iconAfter && iconNode}
    </button>
  );
}

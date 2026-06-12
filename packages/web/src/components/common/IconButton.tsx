import type { ButtonHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';
import { Tooltip } from './Tooltip';

export type IconButtonVariant = 'default' | 'ghost' | 'accent' | 'danger';
export type IconButtonSize = 'sm' | 'md';

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Accessible label; also used as the tooltip text. */
  label: string;
  variant?: IconButtonVariant;
  size?: IconButtonSize;
  active?: boolean;
  /** Suppress the tooltip (e.g. when nested inside another tooltip context). */
  tooltip?: boolean;
}

const base =
  'inline-flex items-center justify-center rounded-md border transition-colors duration-100 ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'disabled:cursor-not-allowed disabled:opacity-40';

const variants: Record<IconButtonVariant, string> = {
  default: 'border-border-base bg-surface-raised text-ink-muted hover:text-ink-strong hover:bg-surface-sunken',
  ghost: 'border-transparent bg-transparent text-ink-muted hover:text-ink-strong hover:bg-surface-sunken',
  accent: 'border-accent bg-accent text-accent-contrast hover:bg-accent-hover',
  danger: 'border-transparent bg-transparent text-ink-muted hover:text-error hover:bg-error-soft',
};

const activeCls = 'border-accent/40 bg-accent-soft text-accent';

const sizes: Record<IconButtonSize, { box: string; icon: number }> = {
  sm: { box: 'h-6 w-6', icon: 14 },
  md: { box: 'h-8 w-8', icon: 16 },
};

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
  const dims = sizes[size];
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
  if (!tooltip) return button;
  return <Tooltip label={label}>{button}</Tooltip>;
}

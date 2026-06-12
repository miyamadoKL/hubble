import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** Compact variant for narrow sidebar panels. */
  compact?: boolean;
}

/** Empty-state design for sidebar panels and result areas (design.md §6). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
  compact = false,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-12',
        className,
      )}
    >
      <span
        className={cn(
          'flex items-center justify-center rounded-lg border border-border-subtle bg-surface-sunken text-ink-subtle',
          compact ? 'h-9 w-9' : 'h-12 w-12',
        )}
      >
        <Icon size={compact ? 18 : 22} strokeWidth={1.5} />
      </span>
      <div className="space-y-1">
        <p className={cn('font-medium text-ink-base', compact ? 'text-sm' : 'text-base')}>{title}</p>
        {description && (
          <p className={cn('text-ink-muted', compact ? 'text-xs' : 'text-sm')}>{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

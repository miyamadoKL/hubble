import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '../../utils/cn';

export interface TabItem<T extends string> {
  id: T;
  label: string;
  icon?: LucideIcon;
  badge?: ReactNode;
  disabled?: boolean;
}

interface TabsProps<T extends string> {
  items: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
  /** 'underline' for result-pane style, 'segmented' for compact pill style. */
  variant?: 'underline' | 'segmented';
}

/**
 * Horizontal tabs. The underline variant renders the signature active-tab
 * underline (design.md §6 "記憶に残るディテール"): a 2px accent bar that sits on
 * the container's hairline.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  variant = 'underline',
}: TabsProps<T>) {
  if (variant === 'segmented') {
    return (
      <div
        role="tablist"
        className={cn(
          'inline-flex items-center gap-0.5 rounded-md border border-border-base bg-surface-inset p-0.5',
          className,
        )}
      >
        {items.map((item) => {
          const active = item.id === value;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              disabled={item.disabled}
              onClick={() => onChange(item.id)}
              className={cn(
                'inline-flex h-6 items-center gap-1.5 rounded-sm px-2 text-xs font-medium transition-colors duration-100',
                'disabled:cursor-not-allowed disabled:opacity-40',
                active
                  ? 'bg-surface-raised text-ink-strong shadow-sm'
                  : 'text-ink-muted hover:text-ink-strong',
              )}
            >
              {Icon && <Icon size={13} strokeWidth={1.75} />}
              {item.label}
              {item.badge}
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      className={cn('flex items-stretch gap-0.5 border-b border-border-base', className)}
    >
      {items.map((item) => {
        const active = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            className={cn(
              'relative inline-flex h-8 items-center gap-1.5 px-3 text-xs font-medium transition-colors duration-100',
              '-mb-px border-b-2 disabled:cursor-not-allowed disabled:opacity-40',
              active
                ? 'border-accent text-ink-strong'
                : 'border-transparent text-ink-muted hover:text-ink-strong',
            )}
          >
            {Icon && <Icon size={14} strokeWidth={1.75} />}
            {item.label}
            {item.badge}
          </button>
        );
      })}
    </div>
  );
}

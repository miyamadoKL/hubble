import type { NotebookListItem } from '@hue-fable/contracts';
import { FileCode2, NotebookPen } from 'lucide-react';
import { EmptyState } from '../common/EmptyState';
import { formatRelativeTime } from '../../utils/format';
import { cn } from '../../utils/cn';

/**
 * Notebook list panel (design.md §5: Notebook 一覧). Shows each saved notebook
 * with its last-updated time; the active notebook is highlighted. Clicking a row
 * opens the notebook (design.md §5: 再オープン). Items are lightweight
 * `NotebookListItem`s from `GET /api/notebooks`.
 */
export function NotebookListPanel({
  notebooks,
  activeId,
  onOpen,
  className,
}: {
  notebooks: NotebookListItem[];
  activeId?: string;
  onOpen?: (id: string) => void;
  className?: string;
}) {
  const now = new Date();
  if (notebooks.length === 0) {
    return (
      <EmptyState
        icon={NotebookPen}
        title="No notebooks"
        description="Create a notebook to start composing SQL cells."
        compact
      />
    );
  }
  return (
    <ul className={cn('flex flex-col', className)}>
      {notebooks.map((nb) => {
        const active = nb.id === activeId;
        return (
          <li key={nb.id} className="border-b border-border-subtle">
            <button
              type="button"
              aria-current={active || undefined}
              onClick={() => onOpen?.(nb.id)}
              className={cn(
                'flex w-full items-start gap-2 px-3 py-2 text-left transition-colors',
                active ? 'bg-accent-soft' : 'hover:bg-surface-sunken',
              )}
            >
              <FileCode2
                size={15}
                strokeWidth={1.75}
                className={cn('mt-0.5 shrink-0', active ? 'text-accent' : 'text-ink-muted')}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'truncate text-sm font-medium',
                    active ? 'text-accent' : 'text-ink-strong',
                  )}
                >
                  {nb.name}
                </p>
                {nb.description && (
                  <p className="mt-0.5 truncate text-xs text-ink-muted">{nb.description}</p>
                )}
                <div className="mt-0.5 flex items-center gap-2 font-mono text-2xs text-ink-subtle">
                  <span>{formatRelativeTime(nb.updatedAt, now)}</span>
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

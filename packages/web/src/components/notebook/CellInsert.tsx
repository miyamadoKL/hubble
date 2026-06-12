import { Code2, FileText, Plus } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * Inter-cell insertion control (design.md §6: 「+ SQL / + Markdown」挿入 UI).
 * A faint hairline with centered actions that surface on hover; clicking inserts
 * a new cell at this slot.
 */
export function CellInsert({
  onAddSql,
  onAddMarkdown,
  className,
}: {
  onAddSql: () => void;
  onAddMarkdown: () => void;
  className?: string;
}) {
  return (
    <div className={cn('group relative flex h-6 items-center justify-center', className)}>
      <span className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border-subtle transition-colors group-hover:bg-border-base" />
      <div className="relative flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          type="button"
          onClick={onAddSql}
          className="inline-flex items-center gap-1 rounded-full border border-border-base bg-surface-raised px-2 py-0.5 text-2xs font-medium text-ink-muted shadow-sm hover:border-accent hover:text-accent"
        >
          <Plus size={11} strokeWidth={2} />
          <Code2 size={11} strokeWidth={1.75} />
          SQL
        </button>
        <button
          type="button"
          onClick={onAddMarkdown}
          className="inline-flex items-center gap-1 rounded-full border border-border-base bg-surface-raised px-2 py-0.5 text-2xs font-medium text-ink-muted shadow-sm hover:border-accent hover:text-accent"
        >
          <Plus size={11} strokeWidth={2} />
          <FileText size={11} strokeWidth={1.75} />
          Markdown
        </button>
      </div>
    </div>
  );
}

import type { ApiErrorDetail } from '@hubble/contracts';
import { CircleAlert } from 'lucide-react';
import { cn } from '../../utils/cn';

/**
 * Execution error panel (design.md §5: メッセージ + trinoErrorName + 位置).
 * Rendered on an error-soft well; the same line/column is also surfaced as a
 * Monaco marker by the cell wiring.
 */
export function ErrorPanel({ error, className }: { error: ApiErrorDetail; className?: string }) {
  const position =
    error.line !== undefined
      ? `line ${error.line}${error.column !== undefined ? `:${error.column}` : ''}`
      : undefined;
  return (
    <div
      className={cn('flex gap-3 bg-error-soft px-4 py-3', className)}
      role="alert"
      data-testid="error-panel"
    >
      <CircleAlert size={16} strokeWidth={2} className="mt-0.5 shrink-0 text-error" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {error.trinoErrorName && (
            <span className="rounded-sm bg-error/15 px-1.5 py-0.5 font-mono text-2xs font-semibold tracking-wide text-error uppercase">
              {error.trinoErrorName}
            </span>
          )}
          {position && (
            <span className="font-mono text-2xs text-ink-muted">{position}</span>
          )}
        </div>
        <p className="mt-1.5 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-base">
          {error.message}
        </p>
      </div>
    </div>
  );
}

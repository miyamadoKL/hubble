import { CircleCheck, CircleX, History, Play } from 'lucide-react';
import type { CellResultMeta } from '@hubble/contracts';
import { formatDuration, formatInt, formatRelativeTime } from '../../utils/format';
import { cn } from '../../utils/cn';

/**
 * "Last run" strip (design.md §4 resultMeta). Shown on a reloaded SQL cell that
 * has a persisted execution summary but no live result yet — full result rows
 * are never persisted, so this is the empty-state stand-in until the user re-runs.
 */
export function LastRunStrip({ meta, onRun }: { meta: CellResultMeta; onRun?: () => void }) {
  const failed = meta.state === 'failed';
  const Icon = failed ? CircleX : CircleCheck;
  const when = meta.executedAt ? formatRelativeTime(meta.executedAt) : null;

  return (
    <div
      data-testid="last-run-strip"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border-subtle bg-surface-sunken px-3 py-2"
    >
      <span className="inline-flex items-center gap-1.5 text-2xs font-semibold tracking-wide text-ink-muted uppercase">
        <History size={12} strokeWidth={2} />
        Last run
      </span>
      <span
        className={cn(
          'inline-flex items-center gap-1 text-xs font-medium',
          failed ? 'text-error' : 'text-success',
        )}
      >
        <Icon size={13} strokeWidth={2} />
        {meta.state ?? 'finished'}
      </span>
      {!failed && meta.rowCount !== undefined && (
        <span className="font-mono text-2xs text-ink-muted tabular-nums">
          {formatInt(meta.rowCount)} rows
        </span>
      )}
      {meta.elapsedMs !== undefined && (
        <span className="font-mono text-2xs text-ink-muted tabular-nums">
          {formatDuration(meta.elapsedMs)}
        </span>
      )}
      {failed && meta.errorMessage && (
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-error" title={meta.errorMessage}>
          {meta.errorMessage}
        </span>
      )}
      <div className="ml-auto flex items-center gap-3">
        {when && <span className="font-mono text-2xs text-ink-subtle">{when}</span>}
        {onRun && (
          <button
            type="button"
            onClick={onRun}
            className="inline-flex items-center gap-1 rounded-sm border border-border-base bg-surface-raised px-1.5 py-0.5 text-2xs font-medium text-ink-muted hover:border-accent/40 hover:text-accent"
          >
            <Play size={10} strokeWidth={2.5} />
            Re-run
          </button>
        )}
      </div>
    </div>
  );
}

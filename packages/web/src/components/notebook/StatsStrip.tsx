import type { QueryState, QueryStats } from '@hue-fable/contracts';
import { ExternalLink, Square, TriangleAlert } from 'lucide-react';
import { StateBadge } from '../common/StateBadge';
import { ProgressBar } from './ProgressBar';
import { formatBytes, formatDuration, formatInt } from '../../utils/format';
import { cn } from '../../utils/cn';

/**
 * Live stats strip + progress (design.md §5: state / progress% / splits / rows /
 * bytes / elapsed ticker, Trino Web UI link, truncated warning, cancel). Sits
 * between the editor and the result pane and updates as SSE stats arrive.
 */

interface StatItemProps {
  label: string;
  value: string;
}

function StatItem({ label, value }: StatItemProps) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-2xs tracking-wide text-ink-subtle uppercase">{label}</span>
      <span className="font-mono text-xs tabular-nums text-ink-base">{value}</span>
    </div>
  );
}

interface StatsStripProps {
  state: QueryState;
  stats?: QueryStats;
  infoUri?: string;
  /** Rows materialised client-side so far (grows as SSE chunks arrive). */
  loadedRows?: number;
  truncated?: boolean;
  /** Shown only while running/queued. */
  onCancel?: () => void;
  className?: string;
}

export function StatsStrip({
  state,
  stats,
  infoUri,
  loadedRows,
  truncated,
  onCancel,
  className,
}: StatsStripProps) {
  const running = state === 'running' || state === 'queued';
  const progress = stats?.progressPercentage;

  return (
    <div className={cn('border-y border-border-subtle bg-surface-base', className)}>
      {running && <ProgressBar value={state === 'queued' ? undefined : progress} />}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 px-3 py-2">
        <StateBadge state={state} />
        {progress !== undefined && running && (
          <StatItem label="progress" value={`${Math.round(progress)}%`} />
        )}
        <StatItem label="elapsed" value={formatDuration(stats?.elapsedTimeMillis ?? 0)} />
        <StatItem
          label="rows"
          value={formatInt(loadedRows ?? stats?.processedRows ?? 0)}
        />
        <StatItem label="bytes" value={formatBytes(stats?.processedBytes ?? 0)} />
        <StatItem
          label="splits"
          value={`${formatInt(stats?.completedSplits ?? 0)}/${formatInt(stats?.totalSplits ?? 0)}`}
        />
        <StatItem label="peak mem" value={formatBytes(stats?.peakMemoryBytes ?? 0)} />

        {truncated && (
          <span className="inline-flex items-center gap-1 rounded-sm bg-warning-soft px-1.5 py-0.5 text-2xs font-medium text-warning">
            <TriangleAlert size={11} strokeWidth={2} />
            truncated
          </span>
        )}

        <div className="ml-auto flex items-center gap-3">
          {running && onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center gap-1 rounded-sm border border-error/40 bg-error-soft px-1.5 py-0.5 text-2xs font-medium text-error hover:border-error"
            >
              <Square size={10} strokeWidth={2.5} />
              Cancel
            </button>
          )}
          {infoUri && (
            <a
              href={infoUri}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-2xs font-medium text-ink-muted hover:text-accent"
            >
              Trino UI
              <ExternalLink size={12} strokeWidth={1.75} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

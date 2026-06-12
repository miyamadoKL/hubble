import type { ScheduleRunStatus } from '@hubble/contracts';
import { cn } from '../../utils/cn';
import { runTone, runStatusLabel, type RunTone } from './scheduleFormat';

/**
 * Status pill for a scheduled run (Query Scheduling feature). Mirrors the shape
 * of the query `StateBadge` but over the schedule-run status set, so the colors
 * come from the same design tokens (success / error / running / warning).
 */

const toneClasses: Record<RunTone, string> = {
  running: 'bg-running-soft text-running',
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  warning: 'bg-warning-soft text-warning',
  neutral: 'bg-surface-inset text-ink-muted',
};

const dotClasses: Record<RunTone, string> = {
  running: 'bg-running',
  success: 'bg-success',
  error: 'bg-error',
  warning: 'bg-warning',
  neutral: 'bg-ink-subtle',
};

export function ScheduleStatusBadge({
  status,
  className,
  dot = true,
}: {
  status: ScheduleRunStatus;
  className?: string;
  dot?: boolean;
}) {
  const tone = runTone(status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5',
        'font-mono text-2xs font-medium tracking-wide uppercase',
        toneClasses[tone],
        className,
      )}
    >
      {dot && (
        <span
          className={cn(
            'h-1.5 w-1.5 shrink-0 rounded-full',
            dotClasses[tone],
            tone === 'running' && 'animate-pulse',
          )}
        />
      )}
      {runStatusLabel(status)}
    </span>
  );
}

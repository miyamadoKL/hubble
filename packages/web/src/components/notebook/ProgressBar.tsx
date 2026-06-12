import { cn } from '../../utils/cn';

interface ProgressBarProps {
  /** 0–100; omit for an indeterminate bar. */
  value?: number;
  className?: string;
}

/**
 * Thin query-progress bar (design.md §5: 進捗 %). Determinate fills with the
 * running color; indeterminate animates a sweeping segment.
 */
export function ProgressBar({ value, className }: ProgressBarProps) {
  const indeterminate = value === undefined;
  return (
    <div
      className={cn('h-0.5 w-full overflow-hidden bg-running-soft', className)}
      role="progressbar"
      aria-valuenow={indeterminate ? undefined : Math.round(value)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      {indeterminate ? (
        <div className="h-full w-1/3 animate-[indeterminate_1.2s_ease-in-out_infinite] bg-running" />
      ) : (
        <div
          className="h-full bg-running transition-[width] duration-150"
          style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
        />
      )}
    </div>
  );
}

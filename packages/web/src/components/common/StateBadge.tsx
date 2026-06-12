import type { QueryState } from '@hubble/contracts';
import { cn } from '../../utils/cn';

/**
 * Semantic state pill (design.md §6: running=blue / success=green / error=red,
 * each with its -soft background). Used by history rows and the stats strip.
 */

type Tone = 'running' | 'success' | 'error' | 'neutral';

const STATE_TONE: Record<QueryState, Tone> = {
  queued: 'neutral',
  running: 'running',
  finished: 'success',
  failed: 'error',
  canceled: 'neutral',
};

const STATE_LABEL: Record<QueryState, string> = {
  queued: 'QUEUED',
  running: 'RUNNING',
  finished: 'FINISHED',
  failed: 'FAILED',
  canceled: 'CANCELED',
};

const toneClasses: Record<Tone, string> = {
  running: 'bg-running-soft text-running',
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  neutral: 'bg-surface-inset text-ink-muted',
};

const dotClasses: Record<Tone, string> = {
  running: 'bg-running',
  success: 'bg-success',
  error: 'bg-error',
  neutral: 'bg-ink-subtle',
};

interface StateBadgeProps {
  state: QueryState;
  className?: string;
  /** Show a leading status dot (pulsing when running). */
  dot?: boolean;
}

export function StateBadge({ state, className, dot = true }: StateBadgeProps) {
  const tone = STATE_TONE[state];
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
      {STATE_LABEL[state]}
    </span>
  );
}

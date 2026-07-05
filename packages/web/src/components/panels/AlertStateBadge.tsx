/**
 * Alert の state を示すバッジコンポーネント。
 */
import type { AlertState } from '@hubble/contracts';
import { cn } from '../../utils/cn';

const stateClasses: Record<AlertState, string> = {
  ok: 'bg-success-soft text-success',
  triggered: 'bg-error-soft text-error',
  unknown: 'bg-surface-inset text-ink-muted',
};

const dotClasses: Record<AlertState, string> = {
  ok: 'bg-success',
  triggered: 'bg-error',
  unknown: 'bg-ink-subtle',
};

const stateLabels: Record<AlertState, string> = {
  ok: 'OK',
  triggered: 'Triggered',
  unknown: 'Unknown',
};

/** Alert state バッジ。 */
export function AlertStateBadge({ state, className }: { state: AlertState; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5',
        'font-mono text-2xs font-medium tracking-wide uppercase',
        stateClasses[state],
        className,
      )}
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClasses[state])} />
      {stateLabels[state]}
    </span>
  );
}

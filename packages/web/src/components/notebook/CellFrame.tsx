import type { ReactNode } from 'react';
import { cn } from '../../utils/cn';

/**
 * Cell container with the signature left status gutter (design.md §6
 * "記憶に残るディテール": セル左端の実行状態ガター). A thin vertical bar reflects the
 * cell's last execution state; it brightens on hover.
 */

export type CellStatus = 'idle' | 'queued' | 'running' | 'finished' | 'failed';

const gutterColor: Record<CellStatus, string> = {
  idle: 'bg-border-base',
  queued: 'bg-ink-subtle',
  running: 'bg-running',
  finished: 'bg-success',
  failed: 'bg-error',
};

interface CellFrameProps {
  status: CellStatus;
  children: ReactNode;
  className?: string;
}

export function CellFrame({ status, children, className }: CellFrameProps) {
  return (
    <div
      className={cn(
        'group/cell relative overflow-hidden rounded-lg border border-border-base bg-surface-raised shadow-sm',
        'transition-colors focus-within:border-border-strong',
        className,
      )}
    >
      {/* Status gutter — the instrument's "needle" for this cell. */}
      <span
        aria-hidden
        className={cn(
          'absolute top-0 left-0 h-full w-1 transition-colors',
          gutterColor[status],
          status === 'running' && 'animate-pulse',
        )}
      />
      <div className="pl-1">{children}</div>
    </div>
  );
}

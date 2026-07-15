/** 状態バッジの描画を共通化する。 */
import { cn } from '../../utils/cn';

/** 状態バッジに使う表示トーン。 */
export type StatusBadgeTone = 'running' | 'success' | 'error' | 'warning' | 'neutral';

const toneClasses: Record<StatusBadgeTone, string> = {
  running: 'bg-running-soft text-running',
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  warning: 'bg-warning-soft text-warning',
  neutral: 'bg-surface-inset text-ink-muted',
};

const dotClasses: Record<StatusBadgeTone, string> = {
  running: 'bg-running',
  success: 'bg-success',
  error: 'bg-error',
  warning: 'bg-warning',
  neutral: 'bg-ink-subtle',
};

/** ラベル、トーン、ドット表示だけを受け取り、runningトーンのドットを点滅させる共通状態バッジ。 */
export function StatusBadge({
  tone,
  label,
  className,
  dot = true,
}: {
  tone: StatusBadgeTone;
  label: string;
  className?: string;
  dot?: boolean;
}) {
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
      {label}
    </span>
  );
}

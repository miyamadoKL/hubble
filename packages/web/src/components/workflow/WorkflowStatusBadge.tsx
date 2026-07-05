/**
 * ワークフロー run のステータスを示す小さなバッジコンポーネント。
 * ScheduleStatusBadge と同じ見た目のコンセプトで、対象を WorkflowRunStatus
 * (running / success / partial / failed / aborted) に変えたもの。
 * 一覧行、ワークフロービューのヘッダー、実行履歴モーダルから利用される。
 */
import type { WorkflowRunStatus } from '@hubble/contracts';
import { cn } from '../../utils/cn';
import { runStatusLabel, runStatusTone, type WorkflowTone } from './workflowFormat';

// トーンごとの背景色と文字色のクラス (バッジ本体の見た目)。
const toneClasses: Record<WorkflowTone, string> = {
  running: 'bg-running-soft text-running',
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  warning: 'bg-warning-soft text-warning',
  neutral: 'bg-surface-inset text-ink-muted',
};

// トーンごとの丸ドット (インジケーター) の色クラス。
const dotClasses: Record<WorkflowTone, string> = {
  running: 'bg-running',
  success: 'bg-success',
  error: 'bg-error',
  warning: 'bg-warning',
  neutral: 'bg-ink-subtle',
};

/**
 * ワークフロー run のステータスバッジを描画する。
 * @param status 表示対象の run ステータス。
 * @param className バッジ本体に追加で適用する Tailwind クラス。
 */
export function WorkflowStatusBadge({
  status,
  className,
}: {
  status: WorkflowRunStatus;
  className?: string;
}) {
  const tone = runStatusTone(status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5',
        'font-mono text-2xs font-medium tracking-wide uppercase',
        toneClasses[tone],
        className,
      )}
    >
      {/* running の間はドットをパルスさせ、実行中であることを視覚的に示す。 */}
      <span
        className={cn(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          dotClasses[tone],
          tone === 'running' && 'animate-pulse',
        )}
      />
      {runStatusLabel(status)}
    </span>
  );
}

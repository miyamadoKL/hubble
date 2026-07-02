/**
 * スケジュール実行 (ScheduleRun) の状態を示す小さなバッジコンポーネント。
 *
 * クエリ履歴の `StateBadge` と見た目のコンセプトは同じだが、対象は
 * ScheduleRunStatus（running / success / failed / aborted / blocked）であり、
 * `scheduleFormat.ts` の `runTone` / `runStatusLabel` を通してデザイントークン
 * ベースの色分けとラベル文字列を得る。SchedulesPanel の一覧行や
 * ScheduleRunsModal の実行履歴行から利用される。
 */
import type { ScheduleRunStatus } from '@hubble/contracts';
import { cn } from '../../utils/cn';
import { runTone, runStatusLabel, type RunTone } from './scheduleFormat';

/**
 * Status pill for a scheduled run (Query Scheduling feature). Mirrors the shape
 * of the query `StateBadge` but over the schedule-run status set, so the colors
 * come from the same design tokens (success / error / running / warning).
 */

// トーンごとの背景色と文字色のクラス（バッジ本体の見た目）。
const toneClasses: Record<RunTone, string> = {
  running: 'bg-running-soft text-running',
  success: 'bg-success-soft text-success',
  error: 'bg-error-soft text-error',
  warning: 'bg-warning-soft text-warning',
  neutral: 'bg-surface-inset text-ink-muted',
};

// トーンごとの丸ドット（インジケーター）の色クラス。
const dotClasses: Record<RunTone, string> = {
  running: 'bg-running',
  success: 'bg-success',
  error: 'bg-error',
  warning: 'bg-warning',
  neutral: 'bg-ink-subtle',
};

/**
 * スケジュール実行の状態バッジを描画する。
 *
 * @param status 表示対象の実行状態（running / success / failed / aborted / blocked）。
 * @param className バッジ本体に追加で適用する Tailwind クラス。
 * @param dot 状態を表す丸ドットを表示するかどうか（デフォルト true）。
 */
export function ScheduleStatusBadge({
  status,
  className,
  dot = true,
}: {
  status: ScheduleRunStatus;
  className?: string;
  dot?: boolean;
}) {
  // status を色トーンへ変換する。
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
      {/* running 状態の間はドットをパルスアニメーションさせ、実行中であることを視覚的に示す。 */}
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

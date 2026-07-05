/**
 * ワークフローの実行履歴モーダル。
 * run サマリ (ステータス、トリガー、開始時刻、所要時間、ステップ内訳) を
 * 新しい順に一覧し、行クリックでその run をキャンバスの表示対象として選択する。
 */
import type { WorkflowRunSummary } from '@hubble/contracts';
import { History as HistoryIcon } from 'lucide-react';
import { Modal } from '../common/Modal';
import { Spinner } from '../common/Spinner';
import { EmptyState } from '../common/EmptyState';
import { useWorkflowRuns } from '../../hooks/useWorkflows';
import { WorkflowStatusBadge } from './WorkflowStatusBadge';
import { formatRelativeTime } from '../../utils/format';
import { cn } from '../../utils/cn';

// 所要時間を人間可読な文字列に変換する。
function elapsedLabel(run: WorkflowRunSummary): string {
  if (run.elapsedMs === null) return '—';
  if (run.elapsedMs < 1000) return `${run.elapsedMs}ms`;
  const seconds = run.elapsedMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.round(seconds / 60)}m`;
}

/**
 * 実行履歴モーダルを描画する。
 * @param open モーダルの表示状態。
 * @param workflowId 対象のワークフロー id (null で取得無効化)。
 * @param selectedRunId 現在キャンバスに表示中の run id (行のハイライトに使う)。
 * @param onSelect run を選択したときのコールバック (選択後にモーダルを閉じる)。
 * @param onClose 閉じるコールバック。
 */
export function WorkflowRunsModal({
  open,
  workflowId,
  selectedRunId,
  onSelect,
  onClose,
}: {
  open: boolean;
  workflowId: string | null;
  selectedRunId: string | null;
  onSelect: (runId: string) => void;
  onClose: () => void;
}) {
  const runs = useWorkflowRuns(open ? workflowId : null);
  if (!open) return null;

  const now = new Date();

  return (
    <Modal open onClose={onClose} title="Run history" className="max-w-2xl">
      {runs.isPending ? (
        <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
          <Spinner size={14} /> Loading…
        </div>
      ) : runs.isError ? (
        <EmptyState
          icon={HistoryIcon}
          title="Couldn't load runs"
          description="The server didn't respond."
          compact
        />
      ) : runs.data.length === 0 ? (
        <EmptyState
          icon={HistoryIcon}
          title="No runs yet"
          description="Run the workflow to see its history here."
          compact
        />
      ) : (
        <ul className="flex max-h-[60vh] flex-col overflow-auto">
          {runs.data.map((run) => (
            <li key={run.id} className="border-b border-border-subtle last:border-b-0">
              <button
                type="button"
                onClick={() => {
                  onSelect(run.id);
                  onClose();
                }}
                aria-current={run.id === selectedRunId || undefined}
                className={cn(
                  'flex w-full flex-wrap items-center gap-2 px-2 py-2 text-left transition-colors',
                  run.id === selectedRunId ? 'bg-accent-soft' : 'hover:bg-surface-sunken',
                )}
              >
                <WorkflowStatusBadge status={run.status} />
                <span className="font-mono text-2xs text-ink-muted uppercase">{run.trigger}</span>
                <span className="font-mono text-2xs text-ink-subtle">
                  {formatRelativeTime(run.startedAt, now)}
                </span>
                <span className="font-mono text-2xs text-ink-subtle">{elapsedLabel(run)}</span>
                {/* ステップ内訳 (成功/失敗/blocked/スキップ)。 */}
                <span className="ml-auto font-mono text-2xs text-ink-subtle">
                  {run.stepCounts.success}/{run.stepCounts.total} ok
                  {run.stepCounts.failed > 0 && ` · ${run.stepCounts.failed} failed`}
                  {run.stepCounts.blocked > 0 && ` · ${run.stepCounts.blocked} blocked`}
                  {run.stepCounts.skipped > 0 && ` · ${run.stepCounts.skipped} skipped`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

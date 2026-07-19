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
import { triggerLabel } from './workflowFormat';
import { formatRelativeTime } from '../../utils/format';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { useLocale } from '../../i18n/locale';
import { commonMessages } from '../../i18n/messages/common';
import { workflowMessages } from '../../i18n/messages/workflow';

/** WorkflowRunsModal 内で使う辞書の合成。共通文言 + workflow 固有文言を 1 つの t() で引けるようにする。 */
const workflowRunsDict = { ...commonMessages, ...workflowMessages } as const;

// 所要時間を人間可読な文字列に変換する。単位表記 (ms/s/m) は言語非依存のため翻訳しない。
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
  const t = useT(workflowRunsDict);
  const { locale } = useLocale();
  const runs = useWorkflowRuns(open ? workflowId : null);
  if (!open) return null;

  const now = new Date();

  return (
    <Modal open onClose={onClose} title={t('runHistoryTitle')} className="max-w-2xl">
      {runs.isPending ? (
        <div className="flex items-center justify-center gap-2 py-8 font-mono text-2xs text-ink-subtle">
          <Spinner size={14} /> {t('loading')}
        </div>
      ) : runs.isError ? (
        <EmptyState
          icon={HistoryIcon}
          title={t('couldntLoadRuns')}
          description={t('serverDidntRespond')}
          compact
        />
      ) : runs.data.length === 0 ? (
        <EmptyState
          icon={HistoryIcon}
          title={t('noRunsYetTitle')}
          description={t('noRunsYetDescription')}
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
                {/* trigger (manual/cron) は契約値なので、そのまま表示せず
                    triggerLabel() 経由で翻訳済みラベルへ変換する。 */}
                <span className="font-mono text-2xs text-ink-muted uppercase">
                  {triggerLabel(run.trigger, locale)}
                </span>
                <span className="font-mono text-2xs text-ink-subtle">
                  {formatRelativeTime(run.startedAt, now, locale)}
                </span>
                <span className="font-mono text-2xs text-ink-subtle">{elapsedLabel(run)}</span>
                {/* ステップ内訳 (成功/失敗/blocked/スキップ)。区切りは runBreakdownSeparator
                    （日本語は読点、英語は既存の " · " 慣習）を辞書から引く。 */}
                <span className="ml-auto font-mono text-2xs text-ink-subtle">
                  {t('stepCountsOk', {
                    success: run.stepCounts.success,
                    total: run.stepCounts.total,
                  })}
                  {run.stepCounts.failed > 0 &&
                    `${t('runBreakdownSeparator')}${t('stepCountsFailed', { n: run.stepCounts.failed })}`}
                  {run.stepCounts.blocked > 0 &&
                    `${t('runBreakdownSeparator')}${t('stepCountsBlocked', { n: run.stepCounts.blocked })}`}
                  {run.stepCounts.skipped > 0 &&
                    `${t('runBreakdownSeparator')}${t('stepCountsSkipped', { n: run.stepCounts.skipped })}`}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

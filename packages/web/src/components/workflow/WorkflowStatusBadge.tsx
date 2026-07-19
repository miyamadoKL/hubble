/**
 * WorkflowRunStatus（running / success / partial / failed / aborted）を共通状態バッジで表示する。
 * 一覧行、ワークフロービューのヘッダー、実行履歴モーダルで利用する。
 */
import type { WorkflowRunStatus } from '@hubble/contracts';
import { StatusBadge } from '../common/StatusBadge';
import { runStatusLabel, runStatusTone } from './workflowFormat';
import { useLocale } from '../../i18n/locale';

/**
 * @param status 表示対象のワークフロー実行状態。
 * @param className バッジ本体に追加するクラス。
 */
export function WorkflowStatusBadge({
  status,
  className,
}: {
  status: WorkflowRunStatus;
  className?: string;
}) {
  const { locale } = useLocale();
  return (
    <StatusBadge
      tone={runStatusTone(status)}
      label={runStatusLabel(status, locale)}
      className={className}
    />
  );
}

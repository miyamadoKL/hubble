/**
 * ScheduleRunStatus（running / success / failed / aborted / blocked）を共通状態バッジで表示する。
 * scheduleFormatのrunToneとrunStatusLabelでトーンとラベルへ変換し、SchedulesPanelと
 * ScheduleRunsModalの実行履歴行で利用する。
 */
import type { ScheduleRunStatus } from '@hubble/contracts';
import { StatusBadge } from '../common/StatusBadge';
import { runTone, runStatusLabel } from './scheduleFormat';
import { useLocale } from '../../i18n/locale';

/**
 * @param status 表示対象のスケジュール実行状態。
 * @param className バッジ本体に追加するクラス。
 * @param dot 状態ドットの表示（デフォルトはtrue）。
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
  const { locale } = useLocale();
  return (
    <StatusBadge
      tone={runTone(status)}
      label={runStatusLabel(status, locale)}
      className={className}
      dot={dot}
    />
  );
}

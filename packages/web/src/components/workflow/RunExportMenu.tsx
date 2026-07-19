/**
 * ワークフロー run の一括エクスポートメニュー。
 * 選択中 run の永続化済みステップ結果を、CSV (zip)、xlsx (複数シートの 1 ブック)、
 * Google Sheets (複数シートの 1 スプレッドシート) のいずれかでまとめて出力する。
 * ResultPane の ExternalExport と同じ Dropdown ベースの操作系に合わせている。
 */
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Dropdown } from '../common/Dropdown';
import { toast } from '../common/Toast';
import {
  downloadWorkflowRunXlsx,
  downloadWorkflowRunZip,
  exportWorkflowRunToSheets,
} from '../../api/workflows';
import { ApiClientError } from '../../api/client';
import { cn } from '../../utils/cn';
import { useT } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { workflowMessages } from '../../i18n/messages/workflow';

/** RunExportMenu 内で使う辞書の合成。共通文言 + workflow 固有文言を 1 つの t() で引けるようにする。 */
const runExportDict = { ...commonMessages, ...workflowMessages } as const;

// メニューに並べるエクスポート形式。
type RunExportAction = 'csv-zip' | 'xlsx' | 'sheets';

/** Blob を一時 object URL としてブラウザーのダウンロードへ渡す。 */
function startBlobDownload(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // click のダウンロード処理が object URL を参照した後に解放する。
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

/**
 * 一括エクスポートメニューを描画する。
 * @param runId 対象の run id。
 * @param disabled 実行中や永続化結果なしのときに操作を無効化する。
 */
export function RunExportMenu({ runId, disabled }: { runId: string; disabled: boolean }) {
  const t = useT(runExportDict);
  // Dropdown は「現在値」を持つ select 系のため、直前に選んだ形式を保持する。
  const [action, setAction] = useState<RunExportAction>('csv-zip');
  const [busy, setBusy] = useState(false);

  const runExport = async (next: RunExportAction) => {
    setAction(next);
    if (disabled || busy) return;
    setBusy(true);
    try {
      if (next === 'csv-zip' || next === 'xlsx') {
        // エラー JSON で SPA を置き換えないよう、HTTP 成否を確認してからダウンロードを開始する。
        const blob =
          next === 'csv-zip'
            ? await downloadWorkflowRunZip(runId)
            : await downloadWorkflowRunXlsx(runId);
        startBlobDownload(
          blob,
          next === 'csv-zip' ? `workflow-run-${runId}.zip` : `workflow-run-${runId}.xlsx`,
        );
        return;
      }
      const response = await exportWorkflowRunToSheets(runId);
      toast.success(t('exportedToSheetsToast'), response.url);
      window.open(response.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const message = err instanceof ApiClientError ? err.detail.message : t('couldNotReachServer');
      toast.error(t('exportFailedToast'), message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn((disabled || busy) && 'pointer-events-none opacity-40')}>
      <Dropdown<RunExportAction>
        value={action}
        onChange={(next) => void runExport(next)}
        leading={<Download size={13} strokeWidth={1.75} />}
        options={[
          { value: 'csv-zip', label: t('exportFormatCsvZip') },
          { value: 'xlsx', label: t('exportFormatXlsx') },
          { value: 'sheets', label: t('googleSheetsOption') },
        ]}
        ariaLabel={t('exportRunResultsAria')}
        align="end"
        className="h-7 text-xs"
      />
    </div>
  );
}

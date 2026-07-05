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
  exportWorkflowRunToSheets,
  workflowRunXlsxUrl,
  workflowRunZipUrl,
} from '../../api/workflows';
import { ApiClientError } from '../../api/client';
import { cn } from '../../utils/cn';

// メニューに並べるエクスポート形式。
type RunExportAction = 'csv-zip' | 'xlsx' | 'sheets';

/**
 * 一括エクスポートメニューを描画する。
 * @param runId 対象の run id。
 * @param disabled 実行中や永続化結果なしのときに操作を無効化する。
 */
export function RunExportMenu({ runId, disabled }: { runId: string; disabled: boolean }) {
  // Dropdown は「現在値」を持つ select 系のため、直前に選んだ形式を保持する。
  const [action, setAction] = useState<RunExportAction>('csv-zip');
  const [busy, setBusy] = useState(false);

  const runExport = async (next: RunExportAction) => {
    setAction(next);
    if (disabled || busy) return;
    if (next === 'csv-zip' || next === 'xlsx') {
      // ダウンロード系はサーバーのストリーミングレスポンスに任せる
      // (Content-Disposition: attachment のためページ遷移は起きない)。
      const url = next === 'csv-zip' ? workflowRunZipUrl(runId) : workflowRunXlsxUrl(runId);
      window.location.assign(url);
      return;
    }
    setBusy(true);
    try {
      const response = await exportWorkflowRunToSheets(runId);
      toast.success('Exported to Google Sheets', response.url);
      window.open(response.url, '_blank', 'noopener,noreferrer');
    } catch (err) {
      const message =
        err instanceof ApiClientError ? err.detail.message : 'Could not reach the server.';
      toast.error('Export failed', message);
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
          { value: 'csv-zip', label: 'CSV (zip)' },
          { value: 'xlsx', label: 'Excel (multi-sheet)' },
          { value: 'sheets', label: 'Google Sheets' },
        ]}
        ariaLabel="Export run results"
        align="end"
        className="h-7 text-xs"
      />
    </div>
  );
}

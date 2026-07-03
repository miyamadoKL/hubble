/**
 * 保存済みクエリや履歴からデータソースを復元するヘルパー。
 */
import type { DatasourceSummary } from '@hubble/contracts';
import { useDatasourceStore } from '../stores/datasourceStore';
import { toast } from '../components/common/Toast';

/**
 * datasourceId が一覧に存在すれば選択を切り替える。
 * 存在しなければ false を返し、呼び出し元はエラートーストを出す。
 */
export function trySelectDatasource(
  datasources: DatasourceSummary[],
  datasourceId: string | undefined | null,
): boolean {
  if (!datasourceId) return true;
  if (!datasources.some((d) => d.id === datasourceId)) return false;
  useDatasourceStore.getState().setSelectedId(datasourceId);
  return true;
}

/**
 * データソースが見つからない場合の共通エラートースト。
 */
export function toastDatasourceMissing(datasourceId: string): void {
  toast.error('Data source not found', `“${datasourceId}” is no longer available.`);
}
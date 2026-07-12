/**
 * 保存済みクエリや履歴からデータソースを復元するヘルパー。
 */
import type { DatasourceSummary } from '@hubble/contracts';
import { useDatasourceStore, type ExecutionContext } from '../stores/datasourceStore';
import { useUiStore } from '../stores/uiStore';
import { useNotebookStore } from '../notebook/notebookStore';
import { readRecentContexts, recordRecentContext } from '../notebook/recentContexts';
import { toast } from '../components/common/Toast';

/**
 * 実行コンテキストを一回の状態更新で適用し、ノートブックとショートカット用ミラーも同期する。
 */
export function tryApplyExecutionContext(
  datasources: DatasourceSummary[],
  next: Partial<ExecutionContext>,
): boolean {
  const datasourceState = useDatasourceStore.getState();
  const current = datasourceState.executionContext;
  const datasourceId = next.datasourceId ?? current.datasourceId ?? datasourceState.selectedId;
  if (!datasourceId || !datasources.some((datasource) => datasource.id === datasourceId)) {
    return false;
  }

  const base =
    current.datasourceId === datasourceId
      ? current
      : (readRecentContexts(datasourceId)[0] ?? {
          datasourceId,
          catalog: '',
          schema: '',
        });
  const resolved: ExecutionContext = {
    datasourceId,
    catalog: next.catalog ?? base.catalog,
    schema: next.schema ?? base.schema,
  };
  datasourceState.setExecutionContext(resolved);

  const ui = useUiStore.getState();
  ui.setShellRuntime(resolved, ui.shellDefaultLimit);
  const notebooks = useNotebookStore.getState();
  if (notebooks.activeId) notebooks.setContext(notebooks.activeId, resolved);
  recordRecentContext({ datasourceId, catalog: resolved.catalog, schema: resolved.schema });
  return true;
}

/**
 * datasourceId が一覧に存在すれば選択を切り替える。
 * 存在しなければ false を返し、呼び出し元はエラートーストを出す。
 */
export function trySelectDatasource(
  datasources: DatasourceSummary[],
  datasourceId: string | undefined | null,
): boolean {
  if (!datasourceId) return true;
  const recent = readRecentContexts(datasourceId)[0];
  return tryApplyExecutionContext(datasources, {
    datasourceId,
    catalog: recent?.catalog ?? '',
    schema: recent?.schema ?? '',
  });
}

/**
 * データソースが見つからない場合の共通エラートースト。
 */
export function toastDatasourceMissing(datasourceId: string): void {
  toast.error('Data source not found', `“${datasourceId}” is no longer available.`);
}

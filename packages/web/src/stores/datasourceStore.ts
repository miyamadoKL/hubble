/**
 * 選択中データソースの状態管理（Zustand + localStorage 永続化）。
 *
 * 起動時に一覧 API と突き合わせ、存在しない id は先頭へフォールバックする
 * 同期は `useDatasources` が担う。本ストアは選択 id の保持と更新のみ行う。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { principalStorageKey } from '../storage/principalStorage';
import { readRecentContexts } from '../notebook/recentContexts';

/** SQL 実行先を一意に定めるデータソース、カタログ、スキーマの組。 */
export interface ExecutionContext {
  datasourceId?: string;
  catalog: string;
  schema: string;
}

interface DatasourceState {
  /** 現在選択中のデータソース id。 */
  selectedId: string | null;
  /** datasourceId、catalog、schema を不可分に保持する現在の実行コンテキスト。 */
  executionContext: ExecutionContext;
  /** 選択中のデータソース id を更新する。 */
  setSelectedId: (id: string) => void;
  /** 実行コンテキストの3値を一回の状態更新で置き換える。 */
  setExecutionContext: (context: ExecutionContext) => void;
}

/** 選択中データソース id を保持する zustand ストア。 */
export const useDatasourceStore = create<DatasourceState>()(
  persist(
    (set) => ({
      selectedId: null,
      executionContext: { catalog: '', schema: '' },
      setSelectedId: (selectedId) =>
        set((state) => {
          if (
            state.selectedId === selectedId &&
            state.executionContext.datasourceId === selectedId
          ) {
            return state;
          }
          const recent = readRecentContexts(selectedId)[0];
          return {
            selectedId,
            executionContext: {
              datasourceId: selectedId,
              catalog: recent?.catalog ?? '',
              schema: recent?.schema ?? '',
            },
          };
        }),
      setExecutionContext: (executionContext) =>
        set({
          selectedId: executionContext.datasourceId ?? null,
          executionContext,
        }),
    }),
    { name: principalStorageKey('hubble-datasource') },
  ),
);

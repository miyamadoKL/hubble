/**
 * 選択中データソースの状態管理（Zustand + localStorage 永続化）。
 *
 * 起動時に一覧 API と突き合わせ、存在しない id は先頭へフォールバックする
 * 同期は `useDatasources` が担う。本ストアは選択 id の保持と更新のみ行う。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface DatasourceState {
  /** 現在選択中のデータソース id。 */
  selectedId: string | null;
  /** 選択中のデータソース id を更新する。 */
  setSelectedId: (id: string) => void;
}

/** 選択中データソース id を保持する zustand ストア。 */
export const useDatasourceStore = create<DatasourceState>()(
  persist(
    (set) => ({
      selectedId: null,
      setSelectedId: (selectedId) => set({ selectedId }),
    }),
    { name: 'hubble-datasource' },
  ),
);

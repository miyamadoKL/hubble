/**
 * データソース一覧の取得と選択状態の同期。
 *
 * TanStack Query で `GET /api/datasources` を取得し、永続化済みの選択 id と
 * 突き合わせる。一覧に無い id は先頭のデータソースへフォールバックする。
 */
import { useEffect, useMemo } from 'react';
import type { DatasourceSummary } from '@hubble/contracts';
import { useQuery } from '@tanstack/react-query';
import { fetchDatasources } from '../api/datasources';
import { useDatasourceStore } from '../stores/datasourceStore';

export const datasourcesQueryKey = ['datasources'] as const;

/**
 * データソース一覧と現在の選択を返すフック。
 */
export function useDatasources(): {
  datasources: DatasourceSummary[];
  selected: DatasourceSummary | undefined;
  selectedId: string | undefined;
  isLoading: boolean;
  isError: boolean;
  setSelectedId: (id: string) => void;
} {
  const query = useQuery({
    queryKey: datasourcesQueryKey,
    queryFn: fetchDatasources,
    staleTime: Infinity,
    retry: 1,
  });

  const selectedId = useDatasourceStore((s) => s.selectedId);
  const setSelectedId = useDatasourceStore((s) => s.setSelectedId);

  const datasources = useMemo(() => query.data?.datasources ?? [], [query.data?.datasources]);

  // 一覧取得後、永続化 id が無効なら先頭へフォールバックする。
  useEffect(() => {
    if (datasources.length === 0) return;
    const ids = new Set(datasources.map((d) => d.id));
    if (!selectedId || !ids.has(selectedId)) {
      setSelectedId(datasources[0]!.id);
    }
  }, [datasources, selectedId, setSelectedId]);

  const effectiveId =
    selectedId && datasources.some((d) => d.id === selectedId)
      ? selectedId
      : datasources[0]?.id;

  const selected = datasources.find((d) => d.id === effectiveId);

  return {
    datasources,
    selected,
    selectedId: effectiveId,
    isLoading: query.isPending,
    isError: query.isError,
    setSelectedId,
  };
}

/**
 * id から displayName を解決する。見つからなければ id をそのまま返す。
 */
export function resolveDatasourceLabel(
  datasources: DatasourceSummary[],
  id: string | undefined | null,
): string {
  if (!id) return '—';
  return datasources.find((d) => d.id === id)?.displayName ?? id;
}

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
 * データソース一覧の staleTime（ミリ秒）。
 * サーバー側は rbac.yaml / datasources.yaml をホットリロードでき、ロールの
 * datasource allowlist が実行時に変わり得る。以前は staleTime: Infinity で
 * invalidate も無かったため、既存タブはページ再読み込みまで古い一覧を表示し
 * 続けていた。allowlist から外れた datasource は一覧から消え、選択中のまま
 * だとその datasource への API 呼び出しが 404 になる。60 秒程度の有限値に
 * することで、タブを開いたまま放置してもそう遠くないうちに一覧が追従する。
 */
export const DATASOURCES_STALE_MS = 60_000;

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
    staleTime: DATASOURCES_STALE_MS,
    // ウィンドウ/タブへのフォーカス復帰時に再取得する。バックグラウンドタブで
    // 放置されている間に allowlist が変わっても、ユーザーが戻ってきた時点で
    // 一覧を追従させるため。
    refetchOnWindowFocus: true,
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
    selectedId && datasources.some((d) => d.id === selectedId) ? selectedId : datasources[0]?.id;

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

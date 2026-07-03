/**
 * Operations ビュー向けの管理クエリ一覧 hook。
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { listAdminQueries, killAdminQuery } from '../api/admin';

const adminQueriesKey = ['admin', 'queries'] as const;

/** パネル表示中のみ 5 秒間隔でポーリングする。 */
const REFETCH_MS = 5_000;

/**
 * 全ユーザーのクエリ一覧を取得する。
 * @param enabled - false のときクエリ自体を無効化する。
 */
export function useAdminQueries(enabled: boolean) {
  return useQuery({
    queryKey: adminQueriesKey,
    queryFn: listAdminQueries,
    enabled,
    refetchInterval: enabled ? REFETCH_MS : false,
  });
}

/** 管理 kill を実行し、成功時に一覧を再取得する。 */
export function useKillAdminQuery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: killAdminQuery,
    onSuccess: () => void qc.invalidateQueries({ queryKey: adminQueriesKey }),
  });
}

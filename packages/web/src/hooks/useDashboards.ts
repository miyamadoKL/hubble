// Dashboard 機能向けの TanStack Query hooks 一式。
// 一覧/単体取得、作成、更新、削除を ../api/dashboards の API 関数を
// 呼び出す形でラップする。パネルのデータ取得 (クエリ実行) は
// components/dashboard/useWidgetData.ts が担当する。

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  CreateDashboardRequest,
  Dashboard,
  DashboardListItem,
  UpdateDashboardRequest,
} from '@hubble/contracts';
import {
  createDashboard,
  deleteDashboard,
  getDashboard,
  listDashboards,
  updateDashboard,
} from '../api/dashboards';

// ダッシュボード一覧のキャッシュキー。
const dashboardsKey = ['dashboards', 'list'] as const;
// 単一ダッシュボードのキャッシュキー。
const dashboardKey = (id: string) => ['dashboards', 'detail', id] as const;

/**
 * ダッシュボード一覧を取得する hook。
 * @param enabled false でクエリを無効化する。
 */
export function useDashboards(enabled = true): UseQueryResult<DashboardListItem[]> {
  return useQuery({
    queryKey: dashboardsKey,
    queryFn: () => listDashboards(),
    enabled,
    refetchOnMount: 'always',
  });
}

/**
 * 単一ダッシュボードを取得する hook。
 * @param id 対象 id。null の場合 (新規作成ビューなど) はクエリを無効化する。
 */
export function useDashboard(id: string | null): UseQueryResult<Dashboard> {
  return useQuery({
    queryKey: dashboardKey(id ?? ''),
    queryFn: () => getDashboard(id!),
    enabled: id !== null,
    refetchOnMount: 'always',
  });
}

/** 一覧と (id 指定時は) 単体のキャッシュをまとめて無効化する内部ヘルパー。 */
function useDashboardInvalidation() {
  const client = useQueryClient();
  return (id?: string) => {
    void client.invalidateQueries({ queryKey: dashboardsKey });
    if (id) {
      void client.invalidateQueries({ queryKey: dashboardKey(id) });
    }
  };
}

/** 新規ダッシュボードを作成する mutation hook。成功時に一覧を無効化する。 */
export function useCreateDashboard() {
  const invalidate = useDashboardInvalidation();
  return useMutation({
    mutationFn: (body: CreateDashboardRequest) => createDashboard(body),
    onSuccess: () => invalidate(),
  });
}

/** 既存ダッシュボードを更新する mutation hook。成功時に一覧と単体を無効化する。 */
export function useUpdateDashboard() {
  const invalidate = useDashboardInvalidation();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: UpdateDashboardRequest }) =>
      updateDashboard(id, body),
    onSuccess: (_data, vars) => invalidate(vars.id),
  });
}

/** ダッシュボードを削除する mutation hook。成功時に一覧を無効化する。 */
export function useDeleteDashboard() {
  const invalidate = useDashboardInvalidation();
  return useMutation({
    mutationFn: (id: string) => deleteDashboard(id),
    onSuccess: () => invalidate(),
  });
}

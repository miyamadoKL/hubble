/**
 * 管理 API（Operations ビュー）のクライアント。
 */
import {
  adminQueriesResponseSchema,
  querySnapshotSchema,
  apiRoutes,
  type AdminQueriesResponse,
  type QuerySnapshot,
} from '@hubble/contracts';
import { apiFetch } from './client';

/**
 * 全ユーザーの実行中/保持中クエリ一覧を取得する。
 */
export function listAdminQueries(): Promise<AdminQueriesResponse> {
  return apiFetch(adminQueriesResponseSchema, apiRoutes.adminQueries());
}

/**
 * 任意ユーザーのクエリを kill する。
 */
export function killAdminQuery(queryId: string): Promise<QuerySnapshot> {
  return apiFetch(querySnapshotSchema, apiRoutes.adminQuery(queryId), { method: 'DELETE' });
}

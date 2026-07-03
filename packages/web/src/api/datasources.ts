/**
 * データソース一覧 API クライアント。
 *
 * `GET /api/datasources` を呼び出し、Web UI のセレクタや displayName 解決に
 * 使う公開サマリー一覧を取得する。
 */
import { datasourcesResponseSchema, type DatasourcesResponse } from '@hubble/contracts';
import { apiFetch, apiRoutes } from './client';

/**
 * 宣言的に設定されたデータソースの公開サマリー一覧を取得する。
 */
export function fetchDatasources(): Promise<DatasourcesResponse> {
  return apiFetch(datasourcesResponseSchema, apiRoutes.datasources());
}
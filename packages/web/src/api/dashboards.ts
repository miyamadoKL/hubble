// Dashboard の CRUD 操作を行うための API クライアントファイル。
// 各関数は apiFetch の薄いラッパーであり、レスポンスを @hubble/contracts の
// zod スキーマで検証する。パネルのデータ取得はここでは扱わない
// (widget が共有 coordinator から既存のクエリ実行 API を呼ぶ。DashboardWidgetData.tsx 参照)。

import { z } from 'zod';
import {
  apiRoutes,
  dashboardResponseSchema,
  dashboardListItemSchema,
  listDocumentSharesResponseSchema,
  type CreateDashboardRequest,
  type DashboardListItem,
  type DashboardResponse,
  type DocumentShare,
  type ListDocumentSharesResponse,
  type UpdateDashboardRequest,
  type UpdateSharesRequest,
} from '@hubble/contracts';
import { apiFetch } from './client';

// 一覧取得レスポンス用のスキーマ。サーバーは一覧アイテムの配列をそのまま返す。
const dashboardListSchema = z.array(dashboardListItemSchema);
// 削除など成否のみを返す操作向けの共通スキーマ。
const okSchema = z.object({ ok: z.boolean() });

/**
 * `GET /api/dashboards` を呼び出し、ダッシュボード一覧を取得する。
 * @param query 名前と説明に対する部分一致 (LIKE) 検索文字列。省略時は全件取得。
 * @returns 一覧アイテムの配列 (widget 本体は含まない)。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function listDashboards(query?: string): Promise<DashboardListItem[]> {
  return apiFetch(dashboardListSchema, apiRoutes.dashboards(), {
    query: query ? { query } : undefined,
  });
}

/**
 * `GET /api/dashboards/:id` を呼び出し、widget を含む単一のダッシュボードを取得する。
 * @param id 対象のダッシュボード id。
 * @returns ダッシュボード全体。
 * @throws {ApiClientError} 存在しない id やリクエスト失敗時。
 */
export function getDashboard(id: string): Promise<DashboardResponse> {
  return apiFetch(dashboardResponseSchema, apiRoutes.dashboard(id));
}

/**
 * `POST /api/dashboards` を呼び出し、新規ダッシュボードを作成する (201)。
 * @param body 作成内容 (CreateDashboardRequest)。
 * @returns 永続化されたダッシュボード (サーバー採番の id を含む)。
 * @throws {ApiClientError} バリデーションエラーとリクエスト失敗時。
 */
export function createDashboard(body: CreateDashboardRequest): Promise<DashboardResponse> {
  return apiFetch(dashboardResponseSchema, apiRoutes.dashboards(), { method: 'POST', body });
}

/**
 * `PUT /api/dashboards/:id` を呼び出し、可変フィールドを全置換する。
 * @param id 更新対象の id。
 * @param body 更新内容 (UpdateDashboardRequest)。
 * @returns 更新後のダッシュボード。
 * @throws {ApiClientError} バリデーションエラーとリクエスト失敗時。
 */
export function updateDashboard(
  id: string,
  body: UpdateDashboardRequest,
): Promise<DashboardResponse> {
  return apiFetch(dashboardResponseSchema, apiRoutes.dashboard(id), { method: 'PUT', body });
}

/**
 * `DELETE /api/dashboards/:id` を呼び出し、ダッシュボードを削除する。
 * @param id 削除対象の id。
 * @returns 削除に成功した場合 true。
 * @throws {ApiClientError} リクエスト失敗時。
 */
export async function deleteDashboard(id: string): Promise<boolean> {
  const res = await apiFetch(okSchema, apiRoutes.dashboard(id), { method: 'DELETE' });
  return res.ok;
}

/**
 * ダッシュボードの共有一覧を取得する (`GET /api/dashboards/:id/shares`)。
 * 所有者のみ呼び出し可能。
 * @param id 対象ダッシュボード id。
 * @returns 共有エントリの配列を含むレスポンス。
 * @throws {ApiClientError} 権限不足、存在しない id、リクエスト失敗時。
 */
export function listDashboardShares(id: string): Promise<ListDocumentSharesResponse> {
  return apiFetch(listDocumentSharesResponseSchema, apiRoutes.dashboardShares(id));
}

/**
 * ダッシュボードの共有一覧を全置換する (`PUT /api/dashboards/:id/shares`)。
 * 所有者のみ呼び出し可能。
 * @param id 対象ダッシュボード id。
 * @param shares 置き換え後の共有エントリ (createdAt なし)。
 * @returns 更新後の共有一覧。
 * @throws {ApiClientError} バリデーションエラー、権限不足、リクエスト失敗時。
 */
export function updateDashboardShares(
  id: string,
  shares: UpdateSharesRequest['shares'],
): Promise<{ shares: DocumentShare[] }> {
  return apiFetch(listDocumentSharesResponseSchema, apiRoutes.dashboardShares(id), {
    method: 'PUT',
    body: { shares },
  });
}

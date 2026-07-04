// Saved-query CRUD fetchers. Thin wrappers over `apiFetch`, each
// validating against the contract schema. `GET /api/saved-queries` returns a
// bare array (server: storeRoutes); the search term is debounced at the call
// site (the panel), not here.
//
// 保存済みクエリ（Saved Query）の CRUD 操作を行うための API クライアントファイル。
// 各関数は apiFetch の薄いラッパーであり、レスポンスを @hubble/contracts の
// zod スキーマで検証する。一覧取得、作成、更新、削除の各操作に対応する。
// 検索語のデバウンス処理は呼び出し元（パネル側）の責務であり、
// このファイルでは行わない。

import { z } from 'zod';
import {
  savedQuerySchema,
  apiRoutes,
  type CreateSavedQueryRequest,
  type SavedQuery,
  type UpdateSavedQueryRequest,
} from '@hubble/contracts';
import { apiFetch } from './client';

// 一覧取得レスポンス用のスキーマ。サーバー（storeRoutes）はオブジェクトで
// ラップせず、保存済みクエリの配列をそのまま返す。
const savedQueryListSchema = z.array(savedQuerySchema);
// 削除など成否のみを返す操作向けの共通スキーマ。
const okSchema = z.object({ ok: z.boolean() });

/**
 * List saved queries, optionally filtered by `query` (name/statement LIKE).
 * `GET /api/saved-queries` を呼び出し、保存済みクエリの一覧を取得する。
 * @param query 名前とSQL文に対する部分一致（LIKE）検索文字列。省略時は全件取得。
 * @returns 保存済みクエリの配列。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function listSavedQueries(query?: string): Promise<SavedQuery[]> {
  return apiFetch(savedQueryListSchema, apiRoutes.savedQueries(), {
    query: query ? { query } : undefined,
  });
}

/**
 * Create a saved query (`POST`, 201) and return the persisted record.
 * `POST /api/saved-queries` を呼び出し、新規の保存済みクエリを作成する。
 * 成功時のステータスコードは 201。
 * @param body 作成する保存済みクエリの内容（CreateSavedQueryRequest）。
 * @returns 永続化された保存済みクエリ（サーバー採番の ID を含む）。
 * @throws {ApiClientError} バリデーションエラーとリクエスト失敗時、
 *                           またはレスポンスがスキーマに一致しない場合。
 */
export function createSavedQuery(body: CreateSavedQueryRequest): Promise<SavedQuery> {
  return apiFetch(savedQuerySchema, apiRoutes.savedQueries(), { method: 'POST', body });
}

/**
 * Replace a saved query's mutable fields (`PUT`).
 * `PUT /api/saved-queries/:id` を呼び出し、既存の保存済みクエリの可変フィールド
 * （名前やSQL文等）を丸ごと置き換える。
 * @param id   更新対象の保存済みクエリ ID。
 * @param body 置き換え後の内容（UpdateSavedQueryRequest）。
 * @returns 更新後の保存済みクエリ。
 * @throws {ApiClientError} バリデーションエラー、存在しない ID、リクエスト失敗時、
 *                           またはレスポンスがスキーマに一致しない場合。
 */
export function updateSavedQuery(id: string, body: UpdateSavedQueryRequest): Promise<SavedQuery> {
  return apiFetch(savedQuerySchema, apiRoutes.savedQuery(id), { method: 'PUT', body });
}

/**
 * Delete a saved query. Resolves true on success.
 * `DELETE /api/saved-queries/:id` を呼び出し、指定の保存済みクエリを削除する。
 * @param id 削除対象の保存済みクエリ ID。
 * @returns 削除に成功した場合 true。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export async function deleteSavedQuery(id: string): Promise<boolean> {
  // サーバーからは { ok: boolean } が返るので、その ok フィールドのみを取り出す。
  const res = await apiFetch(okSchema, apiRoutes.savedQuery(id), { method: 'DELETE' });
  return res.ok;
}

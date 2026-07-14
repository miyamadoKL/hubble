// Notebook CRUD fetchers. Thin wrappers over `apiFetch`, each
// validating against the contract schema. The notebookStore drives these for
// list / open / create / save / delete; the persistence policy (debounce,
// POST-vs-PUT) lives in the store, not here.
//
// ノートブック（Notebook）の CRUD 操作を行うための API クライアントファイル。
// 各関数は apiFetch の薄いラッパーであり、レスポンスを @hubble/contracts の
// zod スキーマで検証する。一覧取得、単体取得、作成、更新、削除の各操作に対応する。
// いつ保存するか（デバウンス）や、新規作成時に POST／更新時に PUT のどちらを
// 使うかといった永続化のポリシーは notebookStore 側の責務であり、
// このファイルはあくまで個々の HTTP 呼び出しを提供するのみ。

import { z } from 'zod';
import {
  notebookResponseSchema,
  notebookListItemSchema,
  apiRoutes,
  listDocumentSharesResponseSchema,
  type CreateNotebookRequest,
  type DocumentShare,
  type ListDocumentSharesResponse,
  type NotebookListItem,
  type NotebookResponse,
  type UpdateNotebookRequest,
  type UpdateSharesRequest,
} from '@hubble/contracts';
import { apiFetch } from './client';

/** `GET /api/notebooks` returns a bare array of list items (server: storeRoutes). */
// 一覧取得レスポンス用のスキーマ。サーバー（storeRoutes）はオブジェクトで
// ラップせず、ノートブック一覧アイテムの配列をそのまま返す。
const notebookListSchema = z.array(notebookListItemSchema);
// 削除など成否のみを返す操作向けの共通スキーマ。
const okSchema = z.object({ ok: z.boolean() });

/**
 * List notebooks, optionally filtered by `query` (name/description LIKE).
 * `GET /api/notebooks` を呼び出し、ノートブックの一覧を取得する。
 * @param query 名前と説明文に対する部分一致（LIKE）検索文字列。省略時は全件取得。
 * @returns ノートブック一覧アイテムの配列。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function listNotebooks(query?: string): Promise<NotebookListItem[]> {
  return apiFetch(notebookListSchema, apiRoutes.notebooks(), {
    query: query ? { query } : undefined,
  });
}

/**
 * Fetch a full notebook (cells/variables/context).
 * `GET /api/notebooks/:id` を呼び出し、セル、変数、実行コンテキストを含む
 * ノートブックの全内容を取得する。
 * @param id 対象ノートブックの ID。
 * @returns ノートブックの全内容（Notebook）。
 * @throws {ApiClientError} リクエスト失敗時（存在しない ID を含む）、
 *                           またはレスポンスがスキーマに一致しない場合。
 */
export function getNotebook(id: string): Promise<NotebookResponse> {
  return apiFetch(notebookResponseSchema, apiRoutes.notebook(id));
}

/**
 * Create a notebook (`POST`, 201) and return the persisted record.
 * `POST /api/notebooks` を呼び出し、新規ノートブックを作成する。
 * 成功時のステータスコードは 201。
 * @param body 作成するノートブックの内容（CreateNotebookRequest）。
 * @returns 永続化されたノートブック（サーバー採番の ID を含む）。
 * @throws {ApiClientError} バリデーションエラーとリクエスト失敗時、
 *                           またはレスポンスがスキーマに一致しない場合。
 */
export function createNotebook(body: CreateNotebookRequest): Promise<NotebookResponse> {
  return apiFetch(notebookResponseSchema, apiRoutes.notebooks(), { method: 'POST', body });
}

/**
 * Replace a notebook's mutable fields (`PUT`).
 * `PUT /api/notebooks/:id` を呼び出し、既存ノートブックの可変フィールド
 * （セル内容や名前等）を丸ごと置き換える。
 * @param id   更新対象のノートブック ID。
 * @param body 置き換え後の内容（UpdateNotebookRequest）。
 * @returns 更新後のノートブック。
 * @throws {ApiClientError} バリデーションエラー、存在しない ID、リクエスト失敗時、
 *                           またはレスポンスがスキーマに一致しない場合。
 */
export function updateNotebook(id: string, body: UpdateNotebookRequest): Promise<NotebookResponse> {
  return apiFetch(notebookResponseSchema, apiRoutes.notebook(id), { method: 'PUT', body });
}

/**
 * Delete a notebook. Resolves true on success.
 * `DELETE /api/notebooks/:id` を呼び出し、指定ノートブックを削除する。
 * @param id 削除対象のノートブック ID。
 * @returns 削除に成功した場合 true。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export async function deleteNotebook(id: string): Promise<boolean> {
  // サーバーからは { ok: boolean } が返るので、その ok フィールドのみを取り出す。
  const res = await apiFetch(okSchema, apiRoutes.notebook(id), { method: 'DELETE' });
  return res.ok;
}

/**
 * ノートブックの共有一覧を取得する (`GET /api/notebooks/:id/shares`)。
 * 所有者のみ呼び出し可能。
 * @param id 対象ノートブック ID。
 * @returns 共有エントリの配列を含むレスポンス。
 * @throws {ApiClientError} 権限不足、存在しない ID、リクエスト失敗時。
 */
export function listNotebookShares(id: string): Promise<ListDocumentSharesResponse> {
  return apiFetch(listDocumentSharesResponseSchema, apiRoutes.notebookShares(id));
}

/**
 * ノートブックの共有一覧を全置換する (`PUT /api/notebooks/:id/shares`)。
 * 所有者のみ呼び出し可能。
 * @param id 対象ノートブック ID。
 * @param shares 置き換え後の共有エントリ（createdAt なし）。
 * @returns 更新後の共有一覧。
 * @throws {ApiClientError} バリデーションエラー、権限不足、リクエスト失敗時。
 */
export function updateNotebookShares(
  id: string,
  shares: UpdateSharesRequest['shares'],
): Promise<{ shares: DocumentShare[] }> {
  return apiFetch(listDocumentSharesResponseSchema, apiRoutes.notebookShares(id), {
    method: 'PUT',
    body: { shares },
  });
}

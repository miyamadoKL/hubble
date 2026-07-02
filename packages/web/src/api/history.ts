// Query-history fetcher (design.md §7). `GET /api/history?offset&limit&state=`
// returns a paged envelope `{ items, offset, limit, total }`. Paging policy
// (offset stepping, page size) lives in the panel's reducer, not here.
//
// クエリ実行履歴（History）を取得するための API クライアントファイル。
// サーバーの `GET /api/history` エンドポイントは offset/limit によるページングと
// state（実行状態）による絞り込みに対応しており、このファイルはそれを型安全に
// 呼び出す薄いラッパーのみを提供する。ページ送りのポリシー（何件ずつ進めるか等）は
// 呼び出し元（履歴パネルの reducer）が担当し、このファイルには持たせない。

import {
  historyResponseSchema,
  type HistoryResponse,
  type QueryState,
  apiRoutes,
} from '@hubble/contracts';
import { apiFetch } from './client';

/** Default page size for the history panel (design.md §5: ページング 50 件). */
// 履歴パネルのデフォルトページサイズ。design.md §5 の仕様に合わせて 50 件固定。
export const HISTORY_PAGE_SIZE = 50;

/** `fetchHistory` に渡す検索やページングパラメータ。 */
export interface HistoryQuery {
  /** 取得を開始する位置（0 始まりのオフセット）。省略時は 0。 */
  offset?: number;
  /** 取得件数。省略時は HISTORY_PAGE_SIZE（50 件）。 */
  limit?: number;
  /** Filter by terminal/running state; omit for all. */
  // 実行状態（例: running / succeeded / failed 等）で絞り込む。省略時は全件対象。
  state?: QueryState;
}

/**
 * Fetch a page of query history.
 * `GET /api/history` を呼び出し、クエリ実行履歴を1ページ分取得する。
 *
 * @param params ページングや絞り込み条件（offset, limit, state）。省略可。
 * @returns ページングされたレスポンス `{ items, offset, limit, total }`。
 * @throws {ApiClientError} リクエスト失敗時、またはレスポンスがスキーマに一致しない場合。
 */
export function fetchHistory(params: HistoryQuery = {}): Promise<HistoryResponse> {
  // デフォルト値を適用（offset: 0, limit: HISTORY_PAGE_SIZE）。
  const { offset = 0, limit = HISTORY_PAGE_SIZE, state } = params;
  // apiFetch 経由で GET /api/history?offset=&limit=&state= を呼び出し、
  // レスポンスを historyResponseSchema で検証する。
  return apiFetch(historyResponseSchema, apiRoutes.history(), {
    query: { offset, limit, state },
  });
}

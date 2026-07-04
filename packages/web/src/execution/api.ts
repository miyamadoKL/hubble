// Typed API helpers for the query lifecycle. Thin wrappers over
// the shared `apiFetch` so the execution store stays focused on state rather
// than fetch/zod plumbing.
//
// ==== ファイルの責務（日本語） ================================================
// クエリのライフサイクル（発行、スナップショット取得、行取得、キャンセル、
// CSV ダウンロード URL 生成）に対応する、型付きの薄い API ラッパー群。
// `apiFetch`（zod によるレスポンス検証込みの fetch ヘルパー）を呼ぶだけの
// シンプルな関数の集まりで、fetch や zod のプラミングを executionStore から
// 隠蔽し、ストア側は状態管理に専念できるようにしている。
// ============================================================================

import {
  createQueryRequestSchema,
  createQueryResponseSchema,
  querySnapshotSchema,
  queryRowsPageSchema,
  queryExportRequestSchema,
  queryExportResponseSchema,
  type CreateQueryRequest,
  type CreateQueryResponse,
  type QuerySnapshot,
  type QueryRowsPage,
  type QueryExportRequest,
  type QueryExportResponse,
} from '@hubble/contracts';
import { apiFetch, apiRoutes } from '../api/client';

/**
 * `POST /api/queries` → 202 `{ queryId }`。
 * クエリの新規実行を要求する。サーバーは即座に queryId のみを返し、実際の
 * 実行結果は SSE（`subscribeQueryEvents`）でストリーミングされる。
 */
/** `POST /api/queries` → 202 `{ queryId }`. */
export function createQuery(request: CreateQueryRequest): Promise<CreateQueryResponse> {
  // Validate the request shape up front so a bad call fails loudly in dev.
  // 送信前にリクエスト形状を zod で検証する。不正な呼び出しは開発時に
  // すぐ気づけるよう、ここで例外を投げて早期に失敗させる。
  const body = createQueryRequestSchema.parse(request);
  return apiFetch(createQueryResponseSchema, apiRoutes.queries(), { method: 'POST', body });
}

/**
 * `GET /api/queries/:id` スナップショット取得。
 * ページ再読み込みや再接続時に、実行中/完了済みクエリの現在状態を
 * 復元するために使う（executionStore.restoreCell から呼ばれる）。
 */
/** `GET /api/queries/:id` snapshot (for reconnect/restore). */
export function fetchQuerySnapshot(queryId: string): Promise<QuerySnapshot> {
  return apiFetch(querySnapshotSchema, apiRoutes.query(queryId));
}

/**
 * `GET /api/queries/:id/rows?offset&limit` 行ページ取得。
 * 再接続時に、サーバー側に既にバッファされている行をまとめて取得するために使う。
 */
/** `GET /api/queries/:id/rows?offset&limit` page (for reconnect/restore). */
export function fetchQueryRows(
  queryId: string,
  offset: number,
  limit: number,
): Promise<QueryRowsPage> {
  return apiFetch(queryRowsPageSchema, apiRoutes.queryRows(queryId), {
    query: { offset, limit },
  });
}

/**
 * `DELETE /api/queries/:id`: 実行中クエリのキャンセル（Trino 側へも伝播する）。
 */
/** `DELETE /api/queries/:id` — cancel (propagates to Trino). */
export async function cancelQuery(queryId: string): Promise<void> {
  const res = await fetch(apiRoutes.query(queryId), { method: 'DELETE' });
  // A 404 (already swept) is fine; anything else is surfaced by the caller's
  // optimistic state, so we don't throw here.
  // 404（既に TTL 掃除済み）は問題ない。それ以外のエラーも、呼び出し側が
  // 楽観的更新した state ですでに反映されているため、ここでは投げない。
  void res;
}

/** Download compression formats exposed in the UI. */
/** UI から選択できるダウンロード時の圧縮形式。 */
export type DownloadFormat = 'csv' | 'zip';

/**
 * CSV ダウンロード URL を組み立てる（ストリーミングのためストア経由の fetch
 * ではなく `<a href>` に直接設定して使う想定）。
 */
/** Build the CSV download URL (used directly as an `a[href]` for streaming). */
export function downloadCsvUrl(queryId: string, format: DownloadFormat): string {
  const base = apiRoutes.queryDownloadCsv(queryId);
  return format === 'zip' ? `${base}?compression=zip` : base;
}

/** Build the xlsx download URL. */
/** xlsx ダウンロード URL を組み立てる。 */
export function downloadXlsxUrl(queryId: string): string {
  return apiRoutes.queryDownloadXlsx(queryId);
}

/** Export a query result to an external destination. */
/** クエリ結果を外部 destination へエクスポートする。 */
export function exportQuery(
  queryId: string,
  request: QueryExportRequest,
): Promise<QueryExportResponse> {
  const body = queryExportRequestSchema.parse(request);
  return apiFetch(queryExportResponseSchema, apiRoutes.queryExport(queryId), {
    method: 'POST',
    body,
  });
}

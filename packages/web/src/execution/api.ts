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
  resultSearchRequestSchema,
  resultSearchPageSchema,
  resultProfileSchema,
  apiErrorSchema,
  type CreateQueryRequest,
  type CreateQueryResponse,
  type QuerySnapshot,
  type QueryRowsPage,
  type QueryExportRequest,
  type QueryExportResponse,
  type ResultSearchRequestInput,
  type ResultSearchPage,
  type ResultProfile,
  type ApiErrorDetail,
} from '@hubble/contracts';
import { ApiClientError, apiFetch, apiRoutes } from '../api/client';

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
export function fetchQuerySnapshot(queryId: string, signal?: AbortSignal): Promise<QuerySnapshot> {
  return apiFetch(querySnapshotSchema, apiRoutes.query(queryId), { signal });
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
  signal?: AbortSignal,
): Promise<QueryRowsPage> {
  return apiFetch(queryRowsPageSchema, apiRoutes.queryRows(queryId), {
    query: { offset, limit },
    signal,
  });
}

/**
 * `POST /api/queries/:id/rows/search`: server-side filter / sort / search。
 * クライアントに全行が載っていない結果（履歴から開いた永続化結果など）を
 * サーバー側で絞り込み/並べ替えして 1 ページ分取得する。
 *
 * @param queryId - 対象クエリ id。
 * @param request - 検索条件（search、filters、sort、offset、limit）。
 * @returns フィルタ適用後のページと件数情報。
 */
export function searchQueryRows(
  queryId: string,
  request: ResultSearchRequestInput,
  signal?: AbortSignal,
): Promise<ResultSearchPage> {
  // 送信前に zod で検証し、default（offset/limit）も適用する。
  const body = resultSearchRequestSchema.parse(request);
  return apiFetch(resultSearchPageSchema, apiRoutes.queryRowsSearch(queryId), {
    method: 'POST',
    body,
    signal,
  });
}

/**
 * `GET /api/queries/:id/profile`: 列プロファイル取得。
 * null 数、distinct 概算、min/max、頻出値をサーバー側で集計して返す。
 *
 * @param queryId - 対象クエリ id。
 * @returns 列ごとのプロファイル。
 */
export function fetchQueryProfile(queryId: string, signal?: AbortSignal): Promise<ResultProfile> {
  return apiFetch(resultProfileSchema, apiRoutes.queryProfile(queryId), { signal });
}

/**
 * `DELETE /api/queries/:id`: 実行中クエリのキャンセル（Trino 側へも伝播する）。
 */
/** `DELETE /api/queries/:id` — cancel (propagates to Trino). */
export async function cancelQuery(queryId: string): Promise<void> {
  const res = await fetch(apiRoutes.query(queryId), { method: 'DELETE' });
  // 404 は既に掃除済みなので、キャンセル済みと同じ結果として扱う。
  if (res.ok || res.status === 404) return;

  let detail: ApiErrorDetail = {
    code: 'HTTP_ERROR',
    message: `Request failed with status ${res.status}`,
  };
  try {
    const parsed = apiErrorSchema.safeParse(await res.json());
    if (parsed.success) detail = parsed.data.error;
  } catch {
    // 空またはJSONではない応答には、上で作った合成エラーを使う。
  }
  throw new ApiClientError(res.status, detail);
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

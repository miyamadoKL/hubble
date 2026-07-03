/**
 * API path constants and type-safe path builders (design.md §7).
 * The single source of truth for endpoint paths shared by server and web.
 *
 * API のエンドポイントパスを一元管理するファイル。server（ルーティング定義）と
 * web（fetch 呼び出し）の両方がここから import することで、パス文字列の
 * ハードコードやタイポによる不一致を防ぐ。動的セグメントを持つパスは
 * 関数（パスビルダー）として定義し、引数を URL エンコードしたうえで組み立てる。
 */

// パスセグメントに埋め込む値を URL エンコードするためのショートハンド。
const enc = encodeURIComponent;

// 全 API エンドポイントのパス定義（定数 or ビルダー関数）をまとめたオブジェクト。
export const apiRoutes = {
  // ヘルスチェック用エンドポイント。
  healthz: () => '/api/healthz',
  // アプリ設定取得エンドポイント。
  config: () => '/api/config',
  // 宣言的に設定されたデータソース一覧取得。
  datasources: () => '/api/datasources',
  // ログイン中ユーザー情報取得エンドポイント。
  me: () => '/api/me',

  // Metadata
  // カタログ一覧取得。
  catalogs: () => '/api/catalogs',
  // 指定カタログ配下のスキーマ一覧取得。
  schemas: (catalog: string) => `/api/catalogs/${enc(catalog)}/schemas`,
  // 指定スキーマ配下のテーブル一覧取得。
  tables: (catalog: string, schema: string) =>
    `/api/catalogs/${enc(catalog)}/schemas/${enc(schema)}/tables`,
  // 単一テーブルの詳細（カラム一覧など）取得。
  table: (catalog: string, schema: string, table: string) =>
    `/api/catalogs/${enc(catalog)}/schemas/${enc(schema)}/tables/${enc(table)}`,
  // テーブルのサンプル行取得。
  tableSample: (catalog: string, schema: string, table: string) =>
    `/api/catalogs/${enc(catalog)}/schemas/${enc(schema)}/tables/${enc(table)}/sample`,
  // メタデータキャッシュの強制再取得。
  metadataRefresh: () => '/api/metadata/refresh',

  // Datasource-scoped metadata (Phase 2)
  datasourceCatalogs: (datasourceId: string) =>
    `/api/datasources/${enc(datasourceId)}/catalogs`,
  datasourceSchemas: (datasourceId: string, catalog: string) =>
    `/api/datasources/${enc(datasourceId)}/catalogs/${enc(catalog)}/schemas`,
  datasourceTables: (datasourceId: string, catalog: string, schema: string) =>
    `/api/datasources/${enc(datasourceId)}/catalogs/${enc(catalog)}/schemas/${enc(schema)}/tables`,
  datasourceTable: (datasourceId: string, catalog: string, schema: string, table: string) =>
    `/api/datasources/${enc(datasourceId)}/catalogs/${enc(catalog)}/schemas/${enc(schema)}/tables/${enc(table)}`,
  datasourceTableSample: (datasourceId: string, catalog: string, schema: string, table: string) =>
    `/api/datasources/${enc(datasourceId)}/catalogs/${enc(catalog)}/schemas/${enc(schema)}/tables/${enc(table)}/sample`,

  // Queries
  // クエリ実行の開始（POST）/ 一覧などの基点パス。
  queries: () => '/api/queries',
  /** Query Guard scan estimate (Query Guard feature). */
  // Query Guard のスキャン見積もり取得。
  queryEstimate: () => '/api/queries/estimate',
  // 単一クエリのスナップショット取得。
  query: (id: string) => `/api/queries/${enc(id)}`,
  // 単一クエリの進捗を配信する SSE エンドポイント。
  queryEvents: (id: string) => `/api/queries/${enc(id)}/events`,
  // 単一クエリの結果行ページ取得。
  queryRows: (id: string) => `/api/queries/${enc(id)}/rows`,
  // 単一クエリの結果を CSV としてダウンロード。
  queryDownloadCsv: (id: string) => `/api/queries/${enc(id)}/download.csv`,

  // Notebooks
  // ノートブック一覧取得 / 新規作成の基点パス。
  notebooks: () => '/api/notebooks',
  // 単一ノートブックの取得、更新、削除。
  notebook: (id: string) => `/api/notebooks/${enc(id)}`,

  // Saved queries
  // 保存済みクエリ一覧取得 / 新規作成の基点パス。
  savedQueries: () => '/api/saved-queries',
  // 単一の保存済みクエリの取得、更新、削除。
  savedQuery: (id: string) => `/api/saved-queries/${enc(id)}`,

  // History
  // クエリ実行履歴一覧取得。
  history: () => '/api/history',

  // Schedules (Query Scheduling feature)
  // スケジュール一覧取得 / 新規作成の基点パス。
  schedules: () => '/api/schedules',
  // 単一スケジュールの取得、更新、削除。
  schedule: (id: string) => `/api/schedules/${enc(id)}`,
  // スケジュールを即時に手動実行する。
  scheduleRun: (id: string) => `/api/schedules/${enc(id)}/run`,
  // スケジュールの実行履歴一覧取得。
  scheduleRuns: (id: string) => `/api/schedules/${enc(id)}/runs`,
} as const;

/** apiRoutes オブジェクト全体の型（各エンドポイントの型を参照する際に使う）。 */
export type ApiRoutes = typeof apiRoutes;

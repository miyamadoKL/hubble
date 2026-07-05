/**
 * API path constants and type-safe path builders.
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
  datasourceCatalogs: (datasourceId: string) => `/api/datasources/${enc(datasourceId)}/catalogs`,
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
  // 単一クエリの結果を xlsx としてダウンロード。
  queryDownloadXlsx: (id: string) => `/api/queries/${enc(id)}/download.xlsx`,
  // 単一クエリの結果を外部ストレージへエクスポート。
  queryExport: (id: string) => `/api/queries/${enc(id)}/export`,

  // Notebooks
  // ノートブック一覧取得 / 新規作成の基点パス。
  notebooks: () => '/api/notebooks',
  // 単一ノートブックの取得、更新、削除。
  notebook: (id: string) => `/api/notebooks/${enc(id)}`,
  // ノートブックの共有一覧取得と更新。
  notebookShares: (id: string) => `/api/notebooks/${enc(id)}/shares`,

  // Saved queries
  // 保存済みクエリ一覧取得 / 新規作成の基点パス。
  savedQueries: () => '/api/saved-queries',
  // 単一の保存済みクエリの取得、更新、削除。
  savedQuery: (id: string) => `/api/saved-queries/${enc(id)}`,
  // 保存済みクエリの共有一覧取得と更新。
  savedQueryShares: (id: string) => `/api/saved-queries/${enc(id)}/shares`,

  // History
  // クエリ実行履歴一覧取得。
  history: () => '/api/history',

  // Admin (RBAC operations view)
  adminQueries: () => '/api/admin/queries',
  adminQuery: (id: string) => `/api/admin/queries/${enc(id)}`,

  // Schedules (Query Scheduling feature)
  // スケジュール一覧取得 / 新規作成の基点パス。
  schedules: () => '/api/schedules',
  // 単一スケジュールの取得、更新、削除。
  schedule: (id: string) => `/api/schedules/${enc(id)}`,
  // スケジュールを即時に手動実行する。
  scheduleRun: (id: string) => `/api/schedules/${enc(id)}/run`,
  // スケジュールの実行履歴一覧取得。
  scheduleRuns: (id: string) => `/api/schedules/${enc(id)}/runs`,

  // Alerts (threshold-based notifications)
  alerts: () => '/api/alerts',
  alert: (id: string) => `/api/alerts/${enc(id)}`,
  alertEval: (id: string) => `/api/alerts/${enc(id)}/eval`,

  // Dashboards (grid of query/chart panels)
  // ダッシュボード一覧取得 / 新規作成の基点パス。
  dashboards: () => '/api/dashboards',
  // 単一ダッシュボードの取得、更新、削除。
  dashboard: (id: string) => `/api/dashboards/${enc(id)}`,
  // ダッシュボードの共有一覧取得と更新。
  dashboardShares: (id: string) => `/api/dashboards/${enc(id)}/shares`,

  // Workflows (Query Workflow feature)
  workflows: () => '/api/workflows',
  workflow: (id: string) => `/api/workflows/${enc(id)}`,
  workflowRun: (id: string) => `/api/workflows/${enc(id)}/run`,
  workflowRuns: (id: string) => `/api/workflows/${enc(id)}/runs`,
  workflowRunDetail: (runId: string) => `/api/workflow-runs/${enc(runId)}`,
  workflowStepResult: (runId: string, stepRunId: string) =>
    `/api/workflow-runs/${enc(runId)}/steps/${enc(stepRunId)}/result`,
  workflowRunDownloadZip: (runId: string) => `/api/workflow-runs/${enc(runId)}/download.zip`,
  workflowRunDownloadXlsx: (runId: string) => `/api/workflow-runs/${enc(runId)}/download.xlsx`,
  workflowRunExport: (runId: string) => `/api/workflow-runs/${enc(runId)}/export`,

  // GitHub integration
  githubStatus: () => '/api/github/status',
  githubConnect: () => '/api/github/connect',
  githubConnection: () => '/api/github/connection',
  githubDocumentStatus: (type: string, id: string) =>
    `/api/github/documents/${enc(type)}/${enc(id)}/status`,
  githubDocumentPush: (type: string, id: string) =>
    `/api/github/documents/${enc(type)}/${enc(id)}/push`,
  githubDocumentPr: (type: string, id: string) =>
    `/api/github/documents/${enc(type)}/${enc(id)}/pr`,
  githubDocumentPull: (type: string, id: string) =>
    `/api/github/documents/${enc(type)}/${enc(id)}/pull`,
} as const;

/** apiRoutes オブジェクト全体の型（各エンドポイントの型を参照する際に使う）。 */
export type ApiRoutes = typeof apiRoutes;

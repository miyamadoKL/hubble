/**
 * @hubble/contracts — the contract layer.
 * zod schemas + inferred types shared by server and web. Change with care.
 *
 * Hubble の「契約層」パッケージのエントリーポイント。
 * ここでエクスポートされる zod スキーマと、それらから推論される型定義が
 * server (packages/server) と web (packages/web) の間の唯一の正本 (source of truth) となる。
 * API のリクエスト/レスポンス形状を変更する際は、まずこの契約層を更新してから
 * server / web の実装を追従させる。
 */
// 共通プリミティブ（ISO タイムスタンプ、ID など）
export * from './common';
// API エラーレスポンスの共通形状
export * from './error';
// 認証モードと `GET /api/me` の契約
export * from './auth';
// RBAC 権限名の契約
export * from './rbac';
// アプリ設定（`GET /api/config`）の契約
export * from './config';
// データソース一覧（`GET /api/datasources`）の契約
export * from './datasource';
// カタログ / スキーマ / テーブルなどメタデータ系の契約
export * from './metadata';
// クエリ実行（`POST /api/queries` など）の契約
export * from './query';
// 管理 API（Operations ビュー）の契約
export * from './admin';
// Query Guard のスキャン見積もりの契約
export * from './estimate';
// クエリ進捗を配信する SSE イベントの契約
export * from './events';
// チャート設定（セルごとの表示設定）の契約
export * from './chart';
// ノートブック（セルと変数）の契約
export * from './notebook';
// 保存済みクエリの契約
export * from './savedQuery';
// ドキュメント共有の契約
export * from './share';
// クエリ実行履歴の契約
export * from './history';
// クエリスケジューリング（cron 実行）の契約
export * from './schedule';
// Alert（保存クエリ結果の閾値監視）の契約
export * from './alert';
// Dashboard（クエリ結果とチャートのグリッド配置）の契約
export * from './dashboard';
// クエリワークフロー（多段 SQL オーケストレーション）の契約
export * from './workflow';
// GitHub 連携の契約
export * from './github';
// API パス定数とパスビルダー
export * from './routes';

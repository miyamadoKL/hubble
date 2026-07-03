/**
 * データソース設定の解決済み型定義。
 *
 * `loadDatasources()` が YAML または後方互換フォールバックから組み立てる
 * 実行時のデータソース表現。`password` を含むが、ログや API には出さない。
 */
import type { DatasourceKind } from '@hubble/contracts';

/** 全データソース種別で共通の解決済みフィールド。 */
export interface ResolvedDatasourceBase {
  /** 不変のデータソース識別子。 */
  id: string;
  /** データソース種別。 */
  type: DatasourceKind;
  /** UI 表示名。省略時は id と同じ値に解決される。 */
  displayName: string;
  /** 接続用ユーザー名。 */
  username: string;
  /** 解決済みパスワード。ログや API レスポンスには含めない。 */
  password: string;
}

/** Trino データソースの解決済み設定。 */
export interface ResolvedTrinoDatasource extends ResolvedDatasourceBase {
  type: 'trino';
  /** Trino coordinator のベース URL。 */
  baseUrl: string;
  /** `X-Trino-Source` に送る値。 */
  source: string;
}

/** MySQL データソースの解決済み設定。 */
export interface ResolvedMysqlDatasource extends ResolvedDatasourceBase {
  type: 'mysql';
  host: string;
  port: number;
  database: string;
}

/** PostgreSQL データソースの解決済み設定。 */
export interface ResolvedPostgresqlDatasource extends ResolvedDatasourceBase {
  type: 'postgresql';
  host: string;
  port: number;
  database: string;
}

/** 解決済みデータソースの共用体。 */
export type ResolvedDatasource =
  | ResolvedTrinoDatasource
  | ResolvedMysqlDatasource
  | ResolvedPostgresqlDatasource;

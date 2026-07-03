/**
 * QueryEngine 抽象化の型定義。
 *
 * データソース種別ごとのクエリ実行、見積もり、メタデータ取得を統一インターフェースで
 * 表現する。QueryRegistry や MetadataService はこの層を経由してエンジン差を吸収する。
 */
import type {
  Catalog,
  DatasourceCapabilities,
  DatasourceKind,
  EstimateResult,
  SampleRowsResponse,
  SchemaItem,
  TableDetail,
  TableItem,
} from '@hubble/contracts';
import type { TrinoClient } from '../trino/client';
import type { TrinoRequestContext, TrinoSessionMutations } from '../trino/types';
import type { ValidationResult } from '../schedule/validator';

/**
 * QueryExecution が Trino の start/advance ループで利用するステートメント実行クライアント。
 * TrinoClient がこの形を満たす（client.ts は書き換えない）。
 */
export type StatementClient = Pick<TrinoClient, 'start' | 'advance' | 'cancel' | 'waitBackoff'>;

/** クエリ実行時にエンジンへ渡すコンテキスト。 */
export interface ExecutionClientOptions {
  /** ユーザークエリかスケジュール実行か。 */
  source: 'user' | 'scheduled';
  /** impersonation 対象の principal（省略時は技術アカウント）。 */
  user?: string;
  /**
   * principal が query.write を持たない実行では true。
   * MySQL/PostgreSQL はチェックアウト時にセッション read only を設定し、
   * プール返却前にデータソース既定値へ戻す。
   */
  sessionReadOnly?: boolean;
}

/** Trino IO explain（write check 等）の実行コンテキスト。 */
export interface IoExplainExecution {
  client: StatementClient;
  ctx: TrinoRequestContext;
}

/** EXPLAIN 見積もりの入力。 */
export interface EngineEstimateParams {
  statement: string;
  catalog?: string;
  schema?: string;
  principal: string;
}

/** スケジュール事前検証の入力。 */
export interface EngineValidateParams {
  statement: string;
  catalog?: string | null;
  schema?: string | null;
  principal: string;
}

/**
 * データソースごとのクエリエンジン。
 * 既存 Trino 実装の必要十分な抽象であり、MySQL/PostgreSQL は Phase 3 で拡張する。
 */
export interface QueryEngine {
  readonly datasourceId: string;
  readonly kind: DatasourceKind;
  readonly capabilities: DatasourceCapabilities;

  /**
   * ストリーミング実行用のステートメントクライアントを返す。
   * @param opts - 実行種別と impersonation ユーザー。
   * @returns QueryExecution がポーリングループで使うクライアント。
   */
  executionClient(opts: ExecutionClientOptions): StatementClient;

  /**
   * CSV 再実行用のステートメントクライアントを返す（Trino の download ソース）。
   * @param user - impersonation 対象の principal。
   * @returns ダウンロード専用クライアント。
   */
  downloadClient(user?: string): StatementClient;

  /**
   * EXPLAIN ベースのスキャン量見積もり。capabilities.costEstimate が false なら呼ばれない。
   * @param params - 見積もり対象の SQL と実行コンテキスト。
   * @returns Query Guard 用の見積もり結果。
   */
  estimate(params: EngineEstimateParams, guardConfig: EstimateGuardConfig): Promise<EstimateResult>;

  /**
   * EXPLAIN (TYPE VALIDATE) による事前検証。
   * @param params - 検証対象の SQL と実行コンテキスト。
   * @returns 検証結果。
   */
  validate(params: EngineValidateParams): Promise<ValidationResult>;

  /**
   * Trino の IO explain 実行に使うクライアントとコンテキスト（write check 用）。
   * Trino 以外は undefined。
   */
  ioExplainExecution?(params: EngineEstimateParams): IoExplainExecution | undefined;

  /** カタログ一覧を返す。 */
  listCatalogs(): Promise<Catalog[]>;
  /** スキーマ一覧を返す。 */
  listSchemas(catalog: string): Promise<SchemaItem[]>;
  /** テーブル一覧を返す。 */
  listTables(catalog: string, schema: string): Promise<TableItem[]>;
  /** テーブル詳細（カラム一覧）を返す。 */
  describeTable(catalog: string, schema: string, table: string): Promise<TableDetail>;
  /** サンプル行を返す。 */
  sampleTable(
    catalog: string,
    schema: string,
    table: string,
    limit?: number,
  ): Promise<SampleRowsResponse>;
}

/** EstimateService からエンジンへ渡す Query Guard 設定。 */
export interface EstimateGuardConfig {
  mode: 'off' | 'warn' | 'enforce';
  maxScanBytes: number;
  maxScanRows: number;
  onUnknown: 'allow' | 'warn' | 'block';
  estimateTimeoutMs: number;
  bytesPerSecond: number;
}

/** drainStatement / CSV 再実行で使う実行コンテキスト組み立て用。 */
export interface EngineRunContext {
  catalog?: string;
  schema?: string;
  source: string;
  user?: string;
  sessionProperties?: Record<string, string>;
}

/** TrinoRequestContext へ変換する。 */
export function toTrinoContext(ctx: EngineRunContext): TrinoRequestContext {
  return {
    catalog: ctx.catalog,
    schema: ctx.schema,
    source: ctx.source,
    user: ctx.user,
    sessionProperties: ctx.sessionProperties,
  };
}

export type { TrinoSessionMutations };

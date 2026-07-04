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
  /** RBAC 解決後の role 名。MySQL/PostgreSQL の roleCredentials 選択に使う。 */
  roleName?: string;
  /**
   * principal が query.write を持たない実行では true。
   * MySQL/PostgreSQL はチェックアウト時にセッション read only を設定し、
   * プール返却前にデータソース既定値へ戻す。
   */
  sessionReadOnly?: boolean;
}

/** CSV 再実行用クライアントの生成オプション。 */
export interface DownloadClientOptions {
  /** impersonation 対象の principal（省略時は技術アカウント）。 */
  user?: string;
  /** RBAC 解決後の role 名。MySQL/PostgreSQL の roleCredentials 選択に使う。 */
  roleName?: string;
  /**
   * principal が query.write を持たないダウンロードでは true。
   * MySQL/PostgreSQL はチェックアウト時にセッション read only を設定する。
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
  roleName?: string;
}

/** スケジュール事前検証の入力。 */
export interface EngineValidateParams {
  statement: string;
  catalog?: string | null;
  schema?: string | null;
  principal: string;
  roleName?: string;
}

/** メタデータ取得時の実行コンテキスト。Trino では X-Trino-User に使う。 */
export interface MetadataOptions {
  /** impersonation 対象の principal（省略時は技術アカウント）。 */
  principal: string;
  /** RBAC 解決後の role 名。MySQL/PostgreSQL の roleCredentials 選択に使う。 */
  roleName?: string;
}

/**
 * MySQL/PostgreSQL 共有 credential 用。principal は DB へ伝播しないが
 * QueryEngine インターフェース互換のため受け取る。
 */
export function ignoreMetadataPrincipal(opts: MetadataOptions): void {
  void opts.principal;
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
   * @param opts - impersonation とセッション read only。
   * @returns ダウンロード専用クライアント。
   */
  downloadClient(opts?: DownloadClientOptions): StatementClient;

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
  listCatalogs(opts: MetadataOptions): Promise<Catalog[]>;
  /** スキーマ一覧を返す。 */
  listSchemas(catalog: string, opts: MetadataOptions): Promise<SchemaItem[]>;
  /** テーブル一覧を返す。 */
  listTables(catalog: string, schema: string, opts: MetadataOptions): Promise<TableItem[]>;
  /** テーブル詳細（カラム一覧）を返す。 */
  describeTable(
    catalog: string,
    schema: string,
    table: string,
    opts: MetadataOptions,
  ): Promise<TableDetail>;
  /** サンプル行を返す。 */
  sampleTable(
    catalog: string,
    schema: string,
    table: string,
    limit: number | undefined,
    opts: MetadataOptions,
  ): Promise<SampleRowsResponse>;

  close(): Promise<void>;

  /**
   * エンジンが close 済みか。ホットリロード後の CSV 再実行可否判定に使う。
   * @returns close() 呼び出し後は true。
   */
  isClosed(): boolean;
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

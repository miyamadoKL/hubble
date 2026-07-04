import type { QueryColumn, QueryStats } from '@hubble/contracts';

/**
 * Raw shapes returned by Trino's `/v1/statement` REST protocol.
 * We only model the fields we consume.
 *
 * 日本語: このファイルは Trino の `/v1/statement` HTTP プロトコルの生レスポンス
 * (JSON) を表す型群と、それらを @hubble/contracts の型 (クライアント/API 向けの
 * 契約型) へ変換するヘルパー関数を提供する。Trino が実際に返すフィールドは
 * ここに定義されているものより多いが、hubble が利用するフィールドのみを
 * モデル化している。
 */

/** Trino のカラム定義 (名前と型名) 。 */
export interface TrinoColumn {
  name: string;
  type: string;
}

/** SQL のエラー発生位置 (1-based の行/列番号)。 */
export interface TrinoErrorLocation {
  lineNumber: number;
  columnNumber: number;
}

/** Trino がレスポンスの `error` フィールドで返すエラー情報。 */
export interface TrinoError {
  message: string;
  errorCode?: number;
  errorName?: string;
  // 日本語: 'USER_ERROR' (SQL 側の問題) か、それ以外 (エンジン/システム側の問題) かで
  // retry.ts の classifyFailure がリトライ可否を分類する際に参照する。
  errorType?: string;
  errorLocation?: TrinoErrorLocation;
}

/** クエリ実行状況の統計情報 (`/v1/statement` レスポンスの `stats` フィールド)。 */
export interface TrinoStats {
  state: string;
  queued?: boolean;
  scheduled?: boolean;
  progressPercentage?: number;
  nodes?: number;
  totalSplits?: number;
  queuedSplits?: number;
  runningSplits?: number;
  completedSplits?: number;
  processedRows?: number;
  processedBytes?: number;
  wallTimeMillis?: number;
  elapsedTimeMillis?: number;
  peakMemoryBytes?: number;
}

/** A single response page from `/v1/statement` (POST result or a `nextUri` GET). */
// 日本語: Trino の /v1/statement プロトコルは「ページング」形式でレスポンスを返す。
// 最初の POST、および以後の nextUri への GET はいずれもこの形の JSON を返し、
// data フィールドにこのページ分の結果行が (あれば) 含まれる。nextUri が
// 存在する限り、呼び出し側 (client.ts の利用者) はそれを追走し続ける必要がある。
// nextUri が消えれば完了 (FINISHED)、error があれば失敗 (FAILED) を意味する。
export interface TrinoStatementResponse {
  id: string;
  infoUri?: string;
  nextUri?: string;
  columns?: TrinoColumn[];
  data?: unknown[][];
  stats: TrinoStats;
  error?: TrinoError;
}

/**
 * Session mutations parsed from `x-trino-set-*` / `x-trino-clear-session`
 * response headers. Applied to the session snapshot on query completion so
 * `SET CATALOG`/`SET SCHEMA`/`SET SESSION` follow-on queries inherit them.
 *
 * 日本語: Trino は `SET CATALOG` 等のステートメントをレスポンスヘッダー経由で
 * 通知する (レスポンスボディの状態には反映されない)。client.ts の
 * applySessionHeaders() が各ページのレスポンスヘッダーからこれらを読み取り、
 * この構造体に蓄積する。呼び出し元 (registry 等) はクエリ完了後にこれを
 * セッションのスナップショットへマージし、次のクエリに引き継ぐ。
 */
export interface TrinoSessionMutations {
  setCatalog?: string;
  setSchema?: string;
  /** session property name -> value (added/changed). */
  setSession: Record<string, string>;
  /** session property names to clear. */
  clearSession: string[];
}

/** Parameters for issuing a statement against Trino. */
// 日本語: TrinoClient.start/advance に渡す、1 リクエスト分のコンテキスト情報。
// HTTP ヘッダー (X-Trino-Catalog 等) へそのままマッピングされる。
export interface TrinoRequestContext {
  catalog?: string;
  schema?: string;
  source?: string;
  /**
   * `X-Trino-User` override for impersonation. When set, the
   * statement runs as this principal instead of the client's technical user.
   * Metadata queries leave this unset and use the technical user.
   */
  user?: string;
  /** Session properties, forwarded as `X-Trino-Session: k=v,...`. */
  sessionProperties?: Record<string, string>;
}

/** 空の `TrinoSessionMutations` を生成するファクトリ。各クエリの開始時に呼ぶ。 */
export function emptySessionMutations(): TrinoSessionMutations {
  return { setSession: {}, clearSession: [] };
}

/** Map a Trino column list to the contract `QueryColumn[]`. */
// 日本語: TrinoColumn[] (undefined の可能性あり) を契約の QueryColumn[] へ変換する。
// undefined の場合は空配列を返す (まだカラム情報が来ていないページなど)。
export function toQueryColumns(columns: TrinoColumn[] | undefined): QueryColumn[] {
  if (!columns) return [];
  return columns.map((c) => ({ name: c.name, type: c.type }));
}

/**
 * Map Trino stats to the contract `QueryStats`. Fields absent in the Trino
 * payload default to 0 (the contract requires them as non-negative ints).
 *
 * 日本語: Trino のレスポンスでは各種カウンタが省略される場合があるが、契約側の
 * QueryStats は非負整数であることを要求するため、undefined は 0 にフォールバック
 * させる。progressPercentage のみ 0-100 にクランプしつつ undefined を許容する
 * (未確定な状態を表現するため)。
 */
export function toQueryStats(stats: TrinoStats): QueryStats {
  return {
    progressPercentage:
      stats.progressPercentage === undefined
        ? undefined
        : Math.max(0, Math.min(100, stats.progressPercentage)),
    state: stats.state,
    queuedSplits: stats.queuedSplits ?? 0,
    runningSplits: stats.runningSplits ?? 0,
    completedSplits: stats.completedSplits ?? 0,
    totalSplits: stats.totalSplits ?? 0,
    processedRows: stats.processedRows ?? 0,
    processedBytes: stats.processedBytes ?? 0,
    wallTimeMillis: stats.wallTimeMillis ?? 0,
    elapsedTimeMillis: stats.elapsedTimeMillis ?? 0,
    peakMemoryBytes: stats.peakMemoryBytes ?? 0,
    nodes: stats.nodes,
  };
}

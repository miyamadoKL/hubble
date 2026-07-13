/**
 * クエリ結果オブジェクトの永続化バックエンド定義。
 */
import { Readable } from 'node:stream';

/** 1 回の range 読み取りで許可する最大バイト数。 */
export const RESULT_STORE_MAX_RANGE_BYTES = 16 * 1024 * 1024;

/** ResultStore に保存する artifact の wire format。 */
export type ResultArtifactFormat = 'jsonl.gz' | 'jsonl.zst' | 'parquet';

/** 期限切れ掃除の対象になるオブジェクト。 */
export interface ExpiredResultObject {
  key: string;
}

/** 期限切れ削除の結果。 */
export interface DeleteExpiredResult {
  deleted: string[];
  failed: Array<{ key: string; error: unknown }>;
}

/** ResultStore の外部サービスエラー分類。 */
export type ResultStoreErrorCode =
  | 'not_found'
  | 'precondition_failed'
  | 'range_not_satisfiable'
  | 'backend_error';

/** ResultStore の外部サービスエラーが発生した操作。 */
export type ResultStoreOperation = 'stat' | 'readRange';

/** ResultStoreError の構造化情報。 */
export interface ResultStoreErrorOptions {
  code: ResultStoreErrorCode;
  operation: ResultStoreOperation;
  backendStatus?: number;
}

/** ResultStore の外部サービスエラーを表す安定したエラー型。 */
export class ResultStoreError extends Error {
  readonly code: ResultStoreErrorCode;
  readonly operation: ResultStoreOperation;
  readonly backendStatus?: number;

  constructor(message: string, cause: unknown, options: ResultStoreErrorOptions) {
    super(message, { cause });
    this.name = 'ResultStoreError';
    this.code = options.code;
    this.operation = options.operation;
    this.backendStatus = options.backendStatus;
  }
}

/** 結果オブジェクトへの条件付き読み取りに使うリクエスト情報。 */
export interface ResultStoreRequestOptions {
  /** リクエストを中断するシグナル。 */
  signal?: AbortSignal;
  /** S3 の If-Match などに渡すオブジェクト検証値。 */
  validator?: string;
  /** 特定のオブジェクトバージョンを指定する識別子。 */
  versionId?: string;
}

/** 結果オブジェクトのサイズと検証値。 */
export interface ResultStoreStat {
  /** 保存済みオブジェクトのバイト数。 */
  size: number;
  /** 保存済みオブジェクトを識別する検証値。ETag を返せない backend では省略される。 */
  validator?: string;
  /** 利用可能な場合のオブジェクトバージョン。 */
  versionId?: string;
}

/** 結果保存バックエンドの共通インターフェース。 */
export interface ResultStore {
  /** このバックエンドで実際に保存するかどうか。 */
  readonly enabled: boolean;
  /** 指定 format の artifact を key に保存する。 */
  put(key: string, body: Readable, format: ResultArtifactFormat): Promise<void>;
  /** 指定 key の圧縮 JSONL 読み取りストリームを返す。 */
  getStream(key: string): Promise<Readable>;
  /** 指定 key の保存済みバイト列のサイズ、validator、利用可能な versionId を返す。 */
  stat(key: string, options?: ResultStoreRequestOptions): Promise<ResultStoreStat>;
  /**
   * 保存済みの raw bytes を半開区間 [offset, offset + length) で返す。
   * compressed object を解凍せず、要求した length と異なる結果や EOF 超過を短縮して返さず失敗する。
   * stat の validator と versionId を options に渡すことで、同一 object の読み取りを検証できる。
   */
  readRange(
    key: string,
    offset: number,
    length: number,
    options?: ResultStoreRequestOptions,
  ): Promise<Buffer>;
  /** 指定 key のオブジェクトを削除する。 */
  delete(key: string): Promise<void>;
  /** 期限切れ候補を削除し、削除できた key と失敗した key を返す。 */
  deleteExpired(objects: ExpiredResultObject[]): Promise<DeleteExpiredResult>;
  /** このバックエンドが所有する通信資源を終了する。 */
  close(): Promise<void>;
}

/** 保存しない設定で使う no-op 実装。 */
export class NoneResultStore implements ResultStore {
  readonly enabled = false;

  async put(_key: string, body: Readable, _format: ResultArtifactFormat): Promise<void> {
    void _format;
    body.resume();
  }

  async getStream(key: string): Promise<Readable> {
    throw new Error(`Result store is disabled: ${key}`);
  }

  async stat(key: string, options?: ResultStoreRequestOptions): Promise<ResultStoreStat> {
    void options;
    throw new Error(`Result store is disabled: ${key}`);
  }

  async readRange(
    key: string,
    offset: number,
    length: number,
    options?: ResultStoreRequestOptions,
  ): Promise<Buffer> {
    void offset;
    void length;
    void options;
    throw new Error(`Result store is disabled: ${key}`);
  }

  async delete(): Promise<void> {}

  async deleteExpired(objects: ExpiredResultObject[]): Promise<DeleteExpiredResult> {
    return { deleted: objects.map((object) => object.key), failed: [] };
  }

  async close(): Promise<void> {}
}

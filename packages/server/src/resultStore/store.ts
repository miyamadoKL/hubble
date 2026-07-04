/**
 * クエリ結果オブジェクトの永続化バックエンド定義。
 */
import { Readable } from 'node:stream';

/** 期限切れ掃除の対象になるオブジェクト。 */
export interface ExpiredResultObject {
  key: string;
}

/** 期限切れ削除の結果。 */
export interface DeleteExpiredResult {
  deleted: string[];
  failed: Array<{ key: string; error: unknown }>;
}

/** 結果保存バックエンドの共通インターフェース。 */
export interface ResultStore {
  /** このバックエンドで実際に保存するかどうか。 */
  readonly enabled: boolean;
  /** gzip JSONL の読み取りストリームを指定 key に保存する。 */
  put(key: string, body: Readable): Promise<void>;
  /** 指定 key の gzip JSONL 読み取りストリームを返す。 */
  getStream(key: string): Promise<Readable>;
  /** 指定 key のオブジェクトを削除する。 */
  delete(key: string): Promise<void>;
  /** 期限切れ候補を削除し、削除できた key と失敗した key を返す。 */
  deleteExpired(objects: ExpiredResultObject[]): Promise<DeleteExpiredResult>;
}

/** 保存しない設定で使う no-op 実装。 */
export class NoneResultStore implements ResultStore {
  readonly enabled = false;

  async put(_key: string, body: Readable): Promise<void> {
    body.resume();
  }

  async getStream(key: string): Promise<Readable> {
    throw new Error(`Result store is disabled: ${key}`);
  }

  async delete(): Promise<void> {}

  async deleteExpired(objects: ExpiredResultObject[]): Promise<DeleteExpiredResult> {
    return { deleted: objects.map((object) => object.key), failed: [] };
  }
}

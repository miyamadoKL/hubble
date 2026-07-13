/**
 * クエリ結果オブジェクトの永続化バックエンド定義。
 */
import { Readable } from 'node:stream';

/** ResultStore に保存する artifact の wire format。 */
export type ResultArtifactFormat = 'jsonl.gz' | 'jsonl.zst';

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
  /** 指定 format の artifact を key に保存する。 */
  put(key: string, body: Readable, format: ResultArtifactFormat): Promise<void>;
  /** 指定 key の圧縮 JSONL 読み取りストリームを返す。 */
  getStream(key: string): Promise<Readable>;
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

  async delete(): Promise<void> {}

  async deleteExpired(objects: ExpiredResultObject[]): Promise<DeleteExpiredResult> {
    return { deleted: objects.map((object) => object.key), failed: [] };
  }

  async close(): Promise<void> {}
}

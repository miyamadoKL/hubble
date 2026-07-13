/**
 * S3 を使うクエリ結果保存バックエンド。
 */
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { DeleteExpiredResult, ExpiredResultObject, ResultStore } from './store';

/** S3 ResultStore の設定。 */
export interface S3ResultStoreOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
}

/** 結果オブジェクトの S3 Content-Encoding。 */
export type ResultContentEncoding = 'gzip' | 'zstd';

const DELETE_CONCURRENCY = 8;

/** S3 ResultStore のテスト用注入ポイント。 */
export interface S3ResultStoreDeps {
  /** 外部所有の client。S3ResultStore はこれを destroy しない。 */
  client?: S3Client;
  uploadFactory?: (params: {
    client: S3Client;
    bucket: string;
    key: string;
    body: Readable;
    contentEncoding: ResultContentEncoding;
  }) => { done(): Promise<unknown> };
}

/** S3 client 設定を構築する。 */
export function buildS3ClientConfig(options: S3ResultStoreOptions): S3ClientConfig {
  return {
    region: options.region,
    endpoint: options.endpoint,
    forcePathStyle: options.endpoint !== undefined,
  };
}

/** S3 の object key に対して圧縮 JSONL を読み書きする ResultStore。 */
export class S3ResultStore implements ResultStore {
  readonly enabled = true;
  private readonly client: S3Client;
  private readonly ownsClient: boolean;
  private readonly uploadFactory: NonNullable<S3ResultStoreDeps['uploadFactory']>;
  private closed = false;

  constructor(
    private readonly options: S3ResultStoreOptions,
    deps: S3ResultStoreDeps = {},
  ) {
    this.ownsClient = deps.client === undefined;
    this.client = deps.client ?? new S3Client(buildS3ClientConfig(options));
    this.uploadFactory =
      deps.uploadFactory ??
      ((params) =>
        new Upload({
          client: params.client,
          params: {
            Bucket: params.bucket,
            Key: params.key,
            Body: params.body,
            ContentType: 'application/x-ndjson',
            ContentEncoding: params.contentEncoding,
          },
        }));
  }

  async put(key: string, body: Readable): Promise<void> {
    const contentEncoding: ResultContentEncoding = key.endsWith('.jsonl.zst') ? 'zstd' : 'gzip';
    await this.uploadFactory({
      client: this.client,
      bucket: this.options.bucket,
      key,
      body,
      contentEncoding,
    }).done();
  }

  async getStream(key: string): Promise<Readable> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
    );
    if (!(result.Body instanceof Readable)) {
      throw new Error(`S3 object body is not a Node stream: ${key}`);
    }
    return result.Body;
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
  }

  async deleteExpired(objects: ExpiredResultObject[]): Promise<DeleteExpiredResult> {
    const deleted: string[] = [];
    const failed: Array<{ key: string; error: unknown }> = [];
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(DELETE_CONCURRENCY, objects.length) },
      async () => {
        while (cursor < objects.length) {
          const object = objects[cursor];
          cursor += 1;
          if (!object) return;
          try {
            await this.delete(object.key);
            deleted.push(object.key);
          } catch (error) {
            failed.push({ key: object.key, error });
          }
        }
      },
    );
    await Promise.all(workers);
    return { deleted, failed };
  }

  async close(): Promise<void> {
    if (this.closed || !this.ownsClient) return;
    this.closed = true;
    this.client.destroy();
  }
}

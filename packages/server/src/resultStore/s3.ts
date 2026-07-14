/**
 * S3 を使うクエリ結果保存バックエンド。
 */
import { Readable } from 'node:stream';
import {
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { DeleteExpiredResult, ExpiredResultObject, ResultStore } from './store';
import {
  defaultResultStoreClock,
  elapsedResultStoreMs,
  resultStoreErrorOutcome,
  safeNotifyResultStoreObserver,
  type ResultStoreClock,
  type ResultStoreMetric,
  type ResultStoreObserver,
} from './observability';

/** S3 ResultStore の設定。 */
export interface S3ResultStoreOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
}

/** zstd JSONL artifact の S3 HTTP metadata を返す。 */
export function resultArtifactMetadata(): {
  contentType: string;
  contentEncoding: 'zstd';
} {
  return { contentType: 'application/x-ndjson', contentEncoding: 'zstd' };
}

const DELETE_BATCH_SIZE = 1_000;

/** S3 ResultStore のテスト用注入ポイント。 */
export interface S3ResultStoreDeps {
  /** 外部所有の client。S3ResultStore はこれを destroy しない。 */
  client?: S3Client;
  /** S3 requestの計測を受け取る任意のobserver。 */
  observer?: ResultStoreObserver;
  /** S3 requestの時間を測る単調増加時計。 */
  clock?: ResultStoreClock;
  uploadFactory?: (params: {
    client: S3Client;
    bucket: string;
    key: string;
    body: Readable;
    contentType: string;
    contentEncoding: 'zstd';
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
  private readonly observer: ResultStoreObserver | undefined;
  private readonly clock: ResultStoreClock;
  private closed = false;

  constructor(
    private readonly options: S3ResultStoreOptions,
    deps: S3ResultStoreDeps = {},
  ) {
    this.ownsClient = deps.client === undefined;
    this.client = deps.client ?? new S3Client(buildS3ClientConfig(options));
    this.observer = deps.observer;
    this.clock = deps.clock ?? defaultResultStoreClock;
    this.uploadFactory =
      deps.uploadFactory ??
      ((params) =>
        new Upload({
          client: params.client,
          params: {
            Bucket: params.bucket,
            Key: params.key,
            Body: params.body,
            ContentType: params.contentType,
            ContentEncoding: params.contentEncoding,
          },
        }));
  }

  async put(key: string, body: Readable): Promise<void> {
    const metadata = resultArtifactMetadata();
    await this.uploadFactory({
      client: this.client,
      bucket: this.options.bucket,
      key,
      body,
      contentType: metadata.contentType,
      contentEncoding: metadata.contentEncoding,
    }).done();
  }

  async getStream(key: string, signal?: AbortSignal): Promise<Readable> {
    const startedAt = this.observer ? this.clock() : undefined;
    try {
      const result = await this.client.send(
        new GetObjectCommand({ Bucket: this.options.bucket, Key: key }),
        signal === undefined ? undefined : { abortSignal: signal },
      );
      if (!(result.Body instanceof Readable)) {
        throw new Error(`S3 object body is not a Node stream: ${key}`);
      }
      this.notifyRequest(startedAt, {
        kind: 's3-request',
        operation: 'get',
        outcome: 'success',
      });
      const body = result.Body;
      const closeOnAbort = (): void => {
        body.destroy();
      };
      const cleanup = (): void => {
        signal?.removeEventListener('abort', closeOnAbort);
      };
      signal?.addEventListener('abort', closeOnAbort, { once: true });
      body.once('end', cleanup);
      body.once('close', cleanup);
      if (signal?.aborted) closeOnAbort();
      return body;
    } catch (error) {
      this.notifyRequest(startedAt, {
        kind: 's3-request',
        operation: 'get',
        outcome: resultStoreErrorOutcome(error, signal),
      });
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const startedAt = this.observer ? this.clock() : undefined;
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.options.bucket, Key: key }));
      this.notifyRequest(startedAt, {
        kind: 's3-request',
        operation: 'delete',
        outcome: 'success',
        batchSize: 1,
      });
    } catch (error) {
      this.notifyRequest(startedAt, {
        kind: 's3-request',
        operation: 'delete',
        outcome: resultStoreErrorOutcome(error),
        batchSize: 1,
      });
      throw error;
    }
  }

  async deleteExpired(objects: ExpiredResultObject[]): Promise<DeleteExpiredResult> {
    const deleted: string[] = [];
    const failed: Array<{ key: string; error: unknown }> = [];
    // 入力重複は冪等な削除として一意化し、結果も key ごとに一件へ揃える。
    const keys = [...new Set(objects.map((object) => object.key))];
    for (let offset = 0; offset < keys.length; offset += DELETE_BATCH_SIZE) {
      const batch = keys.slice(offset, offset + DELETE_BATCH_SIZE);
      const startedAt = this.observer ? this.clock() : undefined;
      try {
        const response = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.options.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: false },
          }),
        );
        const errorByKey = new Map<string, unknown>();
        for (const error of response.Errors ?? []) {
          if (error.Key !== undefined) {
            errorByKey.set(
              error.Key,
              new Error(error.Message ?? `S3 bulk delete failed for key: ${error.Key}`),
            );
          }
        }
        const deletedKeys = new Set(
          (response.Deleted ?? [])
            .map((entry) => entry.Key)
            .filter((key): key is string => key !== undefined),
        );
        let failedItems = 0;
        for (const key of batch) {
          const error = errorByKey.get(key);
          if (error !== undefined) {
            failed.push({ key, error });
            failedItems += 1;
          } else if (deletedKeys.has(key)) {
            deleted.push(key);
          } else {
            failed.push({
              key,
              error: new Error(`S3 bulk delete response omitted key: ${key}`),
            });
            failedItems += 1;
          }
        }
        this.notifyRequest(startedAt, {
          kind: 's3-request',
          operation: 'delete',
          outcome: 'success',
          batchSize: batch.length,
          failedItems,
        });
      } catch (error) {
        // request 単位の失敗は、その request に含めた key 全件へ対応付ける。
        for (const key of batch) failed.push({ key, error });
        this.notifyRequest(startedAt, {
          kind: 's3-request',
          operation: 'delete',
          outcome: resultStoreErrorOutcome(error),
          batchSize: batch.length,
          failedItems: batch.length,
        });
      }
    }
    return { deleted, failed };
  }

  private notifyRequest(
    startedAt: number | undefined,
    event: Omit<Extract<ResultStoreMetric, { kind: 's3-request' }>, 'durationMs'>,
  ): void {
    if (startedAt === undefined) return;
    safeNotifyResultStoreObserver(this.observer, {
      ...event,
      durationMs: elapsedResultStoreMs(this.clock, startedAt),
    });
  }

  async close(): Promise<void> {
    if (this.closed || !this.ownsClient) return;
    this.closed = true;
    this.client.destroy();
  }
}

/**
 * S3 を使うクエリ結果保存バックエンド。
 */
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3ServiceException,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { RESULT_STORE_MAX_RANGE_BYTES, ResultStoreError } from './store';
import type {
  DeleteExpiredResult,
  ExpiredResultObject,
  ResultStore,
  ResultStoreErrorCode,
  ResultStoreRequestOptions,
  ResultStoreStat,
} from './store';

/** S3 ResultStore の設定。 */
export interface S3ResultStoreOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
}

/** 結果オブジェクトの S3 Content-Encoding。 */
export type ResultContentEncoding = 'gzip' | 'zstd';

const DELETE_CONCURRENCY = 8;

function validateRange(key: string, offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`Invalid range offset for ${key}: ${offset}`);
  }
  if (!Number.isSafeInteger(length) || length <= 0) {
    throw new Error(`Invalid range length for ${key}: ${length}`);
  }
  if (length > RESULT_STORE_MAX_RANGE_BYTES) {
    throw new Error(
      `Result store range length exceeds maximum for ${key}: ${length} > ${RESULT_STORE_MAX_RANGE_BYTES}`,
    );
  }
  if (offset > Number.MAX_SAFE_INTEGER - length) {
    throw new Error(`Invalid range overflow for ${key}: offset=${offset}, length=${length}`);
  }
}

function disposeResponseBody(body: unknown): void {
  if (!(body instanceof Readable)) return;
  body.destroy();
  body.resume();
}

function resultStoreErrorCode(status: number | undefined): ResultStoreErrorCode {
  if (status === 404) return 'not_found';
  if (status === 412) return 'precondition_failed';
  if (status === 416) return 'range_not_satisfiable';
  return 'backend_error';
}

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

  private async sendObjectCommand<T>(
    operation: 'stat' | 'readRange',
    key: string,
    signal: AbortSignal | undefined,
    send: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> {
    try {
      return await send(signal);
    } catch (error) {
      // S3ServiceException だけを ResultStoreError に変換し、AbortError などは元の型を保つ。
      if (!S3ServiceException.isInstance(error)) throw error;
      const status = error.$metadata.httpStatusCode ?? 'unknown';
      throw new ResultStoreError(
        `S3 ResultStore ${operation} failed for ${key} (HTTP status ${status})`,
        error,
        {
          code: resultStoreErrorCode(error.$metadata.httpStatusCode),
          operation,
          ...(error.$metadata.httpStatusCode === undefined
            ? {}
            : { backendStatus: error.$metadata.httpStatusCode }),
        },
      );
    }
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

  async stat(key: string, options: ResultStoreRequestOptions = {}): Promise<ResultStoreStat> {
    const command = new HeadObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      ...(options.validator === undefined ? {} : { IfMatch: options.validator }),
      ...(options.versionId === undefined ? {} : { VersionId: options.versionId }),
    });
    const result = await this.sendObjectCommand('stat', key, options.signal, (signal) =>
      this.client.send(command, signal === undefined ? undefined : { abortSignal: signal }),
    );
    const size = result.ContentLength;
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(
        `S3 HEAD response has invalid ContentLength for ${key}: ${size ?? 'missing'}`,
      );
    }
    return {
      size,
      ...(result.ETag === undefined ? {} : { validator: result.ETag }),
      ...(result.VersionId === undefined ? {} : { versionId: result.VersionId }),
    };
  }

  async readRange(
    key: string,
    offset: number,
    length: number,
    options: ResultStoreRequestOptions = {},
  ): Promise<Buffer> {
    validateRange(key, offset, length);
    const end = offset + length - 1;
    const command = new GetObjectCommand({
      Bucket: this.options.bucket,
      Key: key,
      Range: `bytes=${offset}-${end}`,
      ...(options.validator === undefined ? {} : { IfMatch: options.validator }),
      ...(options.versionId === undefined ? {} : { VersionId: options.versionId }),
    });
    const result = await this.sendObjectCommand('readRange', key, options.signal, (signal) =>
      this.client.send(command, signal === undefined ? undefined : { abortSignal: signal }),
    );
    const status = result.$metadata?.httpStatusCode;
    if (status !== 206) {
      disposeResponseBody(result.Body);
      throw new Error(`S3 range response status ${status ?? 'unknown'} for ${key}; expected 206`);
    }

    const contentRange = result.ContentRange;
    const rangeMatch = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? '');
    const rangeStart = rangeMatch === null ? undefined : Number(rangeMatch[1]);
    const rangeEnd = rangeMatch === null ? undefined : Number(rangeMatch[2]);
    const objectSize = rangeMatch === null ? undefined : Number(rangeMatch[3]);
    if (
      rangeMatch === null ||
      rangeStart === undefined ||
      rangeEnd === undefined ||
      objectSize === undefined ||
      !Number.isSafeInteger(rangeStart) ||
      !Number.isSafeInteger(rangeEnd) ||
      !Number.isSafeInteger(objectSize)
    ) {
      disposeResponseBody(result.Body);
      throw new Error(
        `S3 range response Content-Range mismatch for ${key}: ${contentRange ?? 'missing'}`,
      );
    }
    if (rangeStart !== offset || rangeEnd !== end || objectSize < end + 1) {
      disposeResponseBody(result.Body);
      throw new Error(
        `S3 range response Content-Range mismatch for ${key}: ${contentRange ?? 'missing'}`,
      );
    }

    if (
      result.ContentLength === undefined ||
      !Number.isSafeInteger(result.ContentLength) ||
      result.ContentLength < 0
    ) {
      disposeResponseBody(result.Body);
      throw new Error(
        `S3 range response has invalid ContentLength for ${key}: ${result.ContentLength ?? 'missing'}`,
      );
    }
    if (result.ContentLength !== length) {
      disposeResponseBody(result.Body);
      throw new Error(
        `S3 range response ContentLength mismatch for ${key}: ${result.ContentLength ?? 'missing'}, expected ${length}`,
      );
    }
    if (!(result.Body instanceof Readable)) {
      throw new Error(`S3 range response body is not a Node stream: ${key}`);
    }

    const output = Buffer.allocUnsafe(length);
    let size = 0;
    for await (const chunk of result.Body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (size + buffer.length > length) {
        result.Body.destroy();
        throw new Error(
          `S3 range response body length mismatch for ${key}: ${size + buffer.length}, expected ${length}`,
        );
      }
      buffer.copy(output, size);
      size += buffer.length;
    }
    if (size !== length) {
      throw new Error(
        `S3 range response body length mismatch for ${key}: ${size}, expected ${length}`,
      );
    }
    return output;
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

/**
 * クエリ結果を S3 互換オブジェクトストレージへアップロードする。
 */
import { PassThrough, Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { ExportConfig } from '../config';
import { AppError } from '../errors';
import { buildS3ClientConfig } from '../resultStore/s3';

/** S3 エクスポートの upload 差し替えポイント。 */
export interface S3ExportDeps {
  client?: S3Client;
  uploadFactory?: (params: {
    client: S3Client;
    bucket: string;
    key: string;
    body: Readable;
    contentType: string;
    contentEncoding?: string;
  }) => { done(): Promise<unknown> };
}

/** S3 object key に使えるよう owner を保守的に正規化する。 */
export function sanitizeExportKeySegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._=@-]+/g, '_').slice(0, 128) || 'unknown';
}

/** サーバー側で固定した規則に従って export object key を作る。 */
export function buildExportObjectKey(input: {
  prefix: string;
  owner: string;
  queryId: string;
  timestamp: Date;
  extension: string;
}): string {
  const prefix = input.prefix.endsWith('/') ? input.prefix : `${input.prefix}/`;
  const owner = sanitizeExportKeySegment(input.owner);
  const iso = input.timestamp.toISOString().replace(/[:.]/g, '-');
  return `${prefix}${owner}/${input.queryId}-${iso}.${input.extension}`;
}

/** S3 への 1 回のストリーミングアップロードを表す。 */
export class S3ExportUploader {
  private readonly client: S3Client;
  private readonly uploadFactory: NonNullable<S3ExportDeps['uploadFactory']>;

  constructor(
    private readonly config: ExportConfig['s3'],
    deps: S3ExportDeps = {},
  ) {
    this.client =
      deps.client ??
      new S3Client(
        buildS3ClientConfig({
          bucket: config.bucket ?? '',
          region: config.region,
          endpoint: config.endpoint,
        }),
      );
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
            ...(params.contentEncoding ? { ContentEncoding: params.contentEncoding } : {}),
          },
        }));
  }

  /** bodyWriter が書く内容を S3 へアップロードし、完了したら object key を返す。 */
  async upload(input: {
    key: string;
    contentType: string;
    contentEncoding?: string;
    bodyWriter: (stream: PassThrough) => Promise<void>;
  }): Promise<string> {
    const bucket = this.config.bucket;
    if (!bucket) {
      throw AppError.notImplemented('S3 export is disabled. Set EXPORT_S3_BUCKET to enable it.');
    }

    const stream = new PassThrough();
    const upload = this.uploadFactory({
      client: this.client,
      bucket,
      key: input.key,
      body: stream,
      contentType: input.contentType,
      contentEncoding: input.contentEncoding,
    }).done();
    const writer = input.bodyWriter(stream).catch((err) => {
      stream.destroy(err instanceof Error ? err : new Error(String(err)));
      throw err;
    });
    await Promise.all([upload, writer]);
    return input.key;
  }
}

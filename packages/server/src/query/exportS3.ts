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
  }) => { done(): Promise<unknown>; abort?(): Promise<void> };
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
  private readonly ownsClient: boolean;
  private readonly uploadFactory: NonNullable<S3ExportDeps['uploadFactory']>;

  constructor(
    private readonly config: ExportConfig['s3'],
    deps: S3ExportDeps = {},
  ) {
    this.ownsClient = deps.client === undefined;
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
    try {
      const bucket = this.config.bucket;
      if (!bucket) {
        throw AppError.notImplemented('S3 export is disabled. Set EXPORT_S3_BUCKET to enable it.');
      }

      const stream = new PassThrough();
      // upload 側の失敗で stream を destroy しても、利用側が error listener を
      // 登録していない場合にプロセス未処理エラーへしない。
      stream.on('error', () => undefined);
      const transfer = this.uploadFactory({
        client: this.client,
        bucket,
        key: input.key,
        body: stream,
        contentType: input.contentType,
        contentEncoding: input.contentEncoding,
      });
      let primaryError: unknown;
      const failStream = (error: unknown): void => {
        primaryError ??= error;
        stream.destroy(error instanceof Error ? error : new Error(String(error)));
      };

      // writer を先に開始し、同期的に失敗する upload が stream の listener 登録前に
      // error を発火するレースを避ける。
      const writer = Promise.resolve()
        .then(() => input.bodyWriter(stream))
        .catch(async (error: unknown) => {
          failStream(error);
          await transfer.abort?.().catch(() => undefined);
          throw error;
        });
      const upload = Promise.resolve()
        .then(() => transfer.done())
        .catch((error: unknown) => {
          failStream(error);
          throw error;
        });

      const outcomes = await Promise.allSettled([upload, writer]);
      const failed = outcomes.some((outcome) => outcome.status === 'rejected');
      if (failed) throw primaryError ?? new Error('S3 export failed');
      return input.key;
    } finally {
      if (this.ownsClient) this.client.destroy();
    }
  }
}

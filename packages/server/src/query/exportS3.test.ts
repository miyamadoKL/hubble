import { describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import { buildExportObjectKey, sanitizeExportKeySegment, S3ExportUploader } from './exportS3';

describe('S3 export uploader', () => {
  it('builds server-owned object keys', () => {
    expect(sanitizeExportKeySegment('alice@example.com')).toBe('alice@example.com');
    expect(sanitizeExportKeySegment('../alice/team')).toBe('.._alice_team');
    expect(
      buildExportObjectKey({
        prefix: 'exports',
        owner: 'alice@example.com',
        queryId: 'qry_1',
        timestamp: new Date('2026-07-05T00:00:00.000Z'),
        extension: 'csv.gz',
      }),
    ).toBe('exports/alice@example.com/qry_1-2026-07-05T00-00-00-000Z.csv.gz');
  });

  it('imports the AWS SDK and passes bucket, key, content type, and encoding', async () => {
    expect(typeof S3Client).toBe('function');
    let received:
      | {
          bucket: string;
          key: string;
          contentType: string;
          contentEncoding?: string;
        }
      | undefined;
    const uploader = new S3ExportUploader(
      { bucket: 'bucket', prefix: 'exports/' },
      {
        uploadFactory: (params) => {
          received = {
            bucket: params.bucket,
            key: params.key,
            contentType: params.contentType,
            contentEncoding: params.contentEncoding,
          };
          params.body.resume();
          return { done: async () => undefined };
        },
      },
    );

    await uploader.upload({
      key: 'exports/alice/qry_1.csv.gz',
      contentType: 'text/csv; charset=utf-8',
      contentEncoding: 'gzip',
      bodyWriter: async (stream) => {
        stream.end('a,b\r\n');
      },
    });

    expect(received).toEqual({
      bucket: 'bucket',
      key: 'exports/alice/qry_1.csv.gz',
      contentType: 'text/csv; charset=utf-8',
      contentEncoding: 'gzip',
    });
  });

  it('writer 失敗時は sibling upload を中断する', async () => {
    const writerError = new Error('writer failed');
    let rejectUpload!: (error: unknown) => void;
    const upload = new Promise<never>((_resolve, reject) => {
      rejectUpload = reject;
    });
    const abort = vi.fn(async () => rejectUpload(new Error('upload aborted')));
    const uploader = new S3ExportUploader(
      { bucket: 'bucket', prefix: 'exports/' },
      { uploadFactory: () => ({ done: () => upload, abort }) },
    );

    await expect(
      uploader.upload({
        key: 'exports/alice/qry_1.csv',
        contentType: 'text/csv',
        bodyWriter: async () => {
          throw writerError;
        },
      }),
    ).rejects.toBe(writerError);
    expect(abort).toHaveBeenCalledOnce();
  });

  it('upload 失敗時は sibling writer の stream を中断する', async () => {
    const uploadError = new Error('upload failed');
    const writerStopped = vi.fn();
    const uploader = new S3ExportUploader(
      { bucket: 'bucket', prefix: 'exports/' },
      {
        uploadFactory: () => ({
          done: async () => {
            throw uploadError;
          },
        }),
      },
    );

    await expect(
      uploader.upload({
        key: 'exports/alice/qry_1.csv',
        contentType: 'text/csv',
        bodyWriter: async (stream) => {
          await new Promise<void>((_resolve, reject) => {
            stream.once('error', (error) => {
              writerStopped();
              reject(error);
            });
          });
        },
      }),
    ).rejects.toBe(uploadError);
    expect(writerStopped).toHaveBeenCalledOnce();
  });

  it('内部生成した S3 client だけを upload 終了時に破棄する', async () => {
    const destroyOwned = vi
      .spyOn(S3Client.prototype, 'destroy')
      .mockImplementation(() => undefined);
    const owned = new S3ExportUploader(
      { bucket: 'bucket', prefix: 'exports/' },
      {
        uploadFactory: (params) => {
          params.body.resume();
          return { done: async () => undefined };
        },
      },
    );
    await owned.upload({
      key: 'exports/alice/qry_1.csv',
      contentType: 'text/csv',
      bodyWriter: async (stream) => {
        stream.end('a\n');
      },
    });
    expect(destroyOwned).toHaveBeenCalledOnce();
    destroyOwned.mockRestore();

    const externalDestroy = vi.fn();
    const externalClient = { destroy: externalDestroy } as unknown as S3Client;
    const external = new S3ExportUploader(
      { bucket: 'bucket', prefix: 'exports/' },
      {
        client: externalClient,
        uploadFactory: (params) => {
          params.body.resume();
          return { done: async () => undefined };
        },
      },
    );
    await external.upload({
      key: 'exports/alice/qry_2.csv',
      contentType: 'text/csv',
      bodyWriter: async (stream) => {
        stream.end('a\n');
      },
    });
    expect(externalDestroy).not.toHaveBeenCalled();
  });
});

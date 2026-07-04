import { describe, expect, it } from 'vitest';
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
});

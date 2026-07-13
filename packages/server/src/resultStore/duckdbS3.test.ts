import { describe, expect, it, vi } from 'vitest';
import {
  buildDuckdbS3TemporarySecret,
  createDuckdbS3TemporarySecret,
  parseDuckdbS3Endpoint,
  validateDuckdbS3Scope,
} from './duckdbS3';

describe('DuckDB S3 temporary secret contract', () => {
  it('builds a parameterized credential_chain secret with optional session token', async () => {
    const statement = buildDuckdbS3TemporarySecret({
      name: 'gate_secret',
      scope: 's3://result-bucket/result-prefix/',
      region: 'us-east-1',
      endpoint: 'http://minio.example:9000',
      sessionToken: 'session-token-fixture',
    });

    expect(statement.sql).toContain('CREATE OR REPLACE TEMPORARY SECRET gate_secret');
    expect(statement.sql).toContain('TYPE S3');
    expect(statement.sql).toContain('PROVIDER CREDENTIAL_CHAIN');
    expect(statement.sql).toContain("CHAIN 'env'");
    expect(statement.sql).toContain('SESSION_TOKEN ?');
    expect(statement.sql).not.toContain('session-token-fixture');
    expect(statement.parameters).toEqual([
      'us-east-1',
      'minio.example:9000',
      'path',
      false,
      'session-token-fixture',
      's3://result-bucket/result-prefix/',
    ]);

    const run = vi.fn(async () => undefined);
    await createDuckdbS3TemporarySecret({ run } as never, {
      name: 'gate_secret',
      scope: 's3://result-bucket/result-prefix/',
      region: 'us-east-1',
      endpoint: 'http://minio.example:9000',
      sessionToken: 'session-token-fixture',
    });
    expect(run).toHaveBeenCalledWith(statement.sql, statement.parameters);
  });

  it('uses vhost for AWS default and rejects unsafe endpoint or scope forms', () => {
    expect(parseDuckdbS3Endpoint()).toEqual({ useSsl: true, urlStyle: 'vhost' });
    expect(parseDuckdbS3Endpoint('https://s3.example.com')).toEqual({
      host: 's3.example.com',
      useSsl: true,
      urlStyle: 'path',
    });
    expect(() => parseDuckdbS3Endpoint('https://user:pass@s3.example.com')).toThrow();
    expect(() => parseDuckdbS3Endpoint('https://s3.example.com/base')).toThrow();
    expect(() => parseDuckdbS3Endpoint('https://s3.example.com?x=1')).toThrow();
    expect(validateDuckdbS3Scope('s3://result-bucket/result-prefix/')).toBe(
      's3://result-bucket/result-prefix/',
    );
    expect(() => validateDuckdbS3Scope('https://result-bucket/result-prefix/')).toThrow();
    expect(() => validateDuckdbS3Scope('s3://result-bucket/result-prefix')).toThrow();
  });
});

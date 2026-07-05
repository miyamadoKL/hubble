import { describe, expect, it } from 'vitest';
import { loadServerConfig } from './config';

describe('loadServerConfig integer bounds', () => {
  it('rejects QUERY_CONCURRENCY=0', () => {
    expect(() => loadServerConfig({ QUERY_CONCURRENCY: '0' })).toThrow(/minimum: 1/);
  });

  it('rejects negative QUERY_CONCURRENCY', () => {
    expect(() => loadServerConfig({ QUERY_CONCURRENCY: '-1' })).toThrow(/minimum: 1/);
  });

  it('rejects negative QUERY_MAX_ROWS', () => {
    expect(() => loadServerConfig({ QUERY_MAX_ROWS: '-100' })).toThrow(/minimum: 1/);
  });

  it('accepts QUERY_GUARD_MAX_SCAN_BYTES=0', () => {
    const config = loadServerConfig({ QUERY_GUARD_MAX_SCAN_BYTES: '0' });
    expect(config.guard.maxScanBytes).toBe(0);
  });

  it('rejects negative QUERY_GUARD_MAX_SCAN_BYTES', () => {
    expect(() => loadServerConfig({ QUERY_GUARD_MAX_SCAN_BYTES: '-1' })).toThrow(/minimum: 0/);
  });

  it('defaults ResultStore to none with a 7 day TTL', () => {
    expect(loadServerConfig({}).resultStore).toEqual({ kind: 'none', ttlDays: 7 });
  });

  it('requires an S3 bucket when ResultStore is s3', () => {
    expect(() => loadServerConfig({ RESULT_STORE: 's3' })).toThrow(/RESULT_STORE_S3_BUCKET/);
  });

  it('loads S3 ResultStore settings from env', () => {
    expect(
      loadServerConfig({
        RESULT_STORE: 's3',
        RESULT_STORE_S3_BUCKET: 'bucket',
        RESULT_STORE_S3_PREFIX: 'prefix/',
        RESULT_STORE_S3_REGION: 'us-east-1',
        RESULT_STORE_S3_ENDPOINT: 'http://localhost:9000',
        RESULT_STORE_TTL_DAYS: '30',
      }).resultStore,
    ).toEqual({
      kind: 's3',
      bucket: 'bucket',
      prefix: 'prefix/',
      region: 'us-east-1',
      endpoint: 'http://localhost:9000',
      ttlDays: 30,
    });
  });

  it('defaults export destinations to disabled settings', () => {
    expect(loadServerConfig({}).export).toEqual({
      s3: { prefix: 'hubble-exports/' },
      sheets: {},
    });
  });

  it('loads export destination settings from env', () => {
    expect(
      loadServerConfig({
        EXPORT_S3_BUCKET: 'export-bucket',
        EXPORT_S3_PREFIX: 'exports/',
        EXPORT_S3_REGION: 'us-west-2',
        EXPORT_S3_ENDPOINT: 'http://localhost:9000',
        EXPORT_SHEETS_CREDENTIALS_FILE: '/secure/hubble-sheets.json',
      }).export,
    ).toEqual({
      s3: {
        bucket: 'export-bucket',
        prefix: 'exports/',
        region: 'us-west-2',
        endpoint: 'http://localhost:9000',
      },
      sheets: {
        credentialsFile: '/secure/hubble-sheets.json',
      },
    });
  });

  it('loads notification env including SMTP password indirection', () => {
    const config = loadServerConfig({
      NOTIFY_SLACK_WEBHOOK_URL: 'https://hooks.slack.test/services/T',
      NOTIFY_SMTP_HOST: 'smtp.example.com',
      NOTIFY_SMTP_PORT: '465',
      NOTIFY_SMTP_USER: 'hubble',
      NOTIFY_SMTP_PASSWORD_ENV: 'SMTP_PASSWORD',
      SMTP_PASSWORD: 'secret',
      NOTIFY_SMTP_FROM: 'hubble@example.com',
    });
    expect(config.notification).toEqual({
      slackWebhookUrl: 'https://hooks.slack.test/services/T',
      smtp: {
        host: 'smtp.example.com',
        port: 465,
        user: 'hubble',
        password: 'secret',
        from: 'hubble@example.com',
      },
    });
  });

  it('defaults GitHub integration to disabled', () => {
    expect(loadServerConfig({}).github).toEqual({
      enabled: false,
      defaultBranch: 'main',
      governance: 'off',
      statusTtlSeconds: 120,
      syncCron: null,
    });
  });

  it('loads GitHub integration settings when repo is configured', () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    expect(
      loadServerConfig({
        GITHUB_REPO: 'acme/docs',
        GITHUB_APP_CLIENT_ID: 'cid',
        GITHUB_APP_CLIENT_SECRET: 'sec',
        GITHUB_TOKEN_ENCRYPTION_KEY: key,
        GITHUB_GOVERNANCE: 'on',
        GITHUB_DEFAULT_BRANCH: 'develop',
        GITHUB_STATUS_TTL_SECONDS: '60',
      }).github,
    ).toEqual({
      enabled: true,
      repo: 'acme/docs',
      defaultBranch: 'develop',
      clientId: 'cid',
      clientSecret: 'sec',
      tokenEncryptionKey: Buffer.from(key, 'base64'),
      governance: 'on',
      statusTtlSeconds: 60,
      syncCron: '0 3 * * *',
    });
  });

  it('disables scheduled sync when GITHUB_SYNC_CRON=off', () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    expect(
      loadServerConfig({
        GITHUB_REPO: 'acme/docs',
        GITHUB_APP_CLIENT_ID: 'cid',
        GITHUB_APP_CLIENT_SECRET: 'sec',
        GITHUB_TOKEN_ENCRYPTION_KEY: key,
        GITHUB_SYNC_CRON: 'off',
      }).github.syncCron,
    ).toBeNull();
  });

  it('loads GITHUB_SYNC_TOKEN when configured', () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    expect(
      loadServerConfig({
        GITHUB_REPO: 'acme/docs',
        GITHUB_APP_CLIENT_ID: 'cid',
        GITHUB_APP_CLIENT_SECRET: 'sec',
        GITHUB_TOKEN_ENCRYPTION_KEY: key,
        GITHUB_SYNC_TOKEN: 'server-pat',
      }).github.syncToken,
    ).toBe('server-pat');
  });

  it('rejects invalid GITHUB_SYNC_CRON when repo is configured', () => {
    const key = Buffer.alloc(32, 9).toString('base64');
    expect(() =>
      loadServerConfig({
        GITHUB_REPO: 'acme/docs',
        GITHUB_APP_CLIENT_ID: 'cid',
        GITHUB_APP_CLIENT_SECRET: 'sec',
        GITHUB_TOKEN_ENCRYPTION_KEY: key,
        GITHUB_SYNC_CRON: 'not-a-cron',
      }),
    ).toThrow(/GITHUB_SYNC_CRON/);
  });

  it('rejects invalid GitHub encryption key when repo is configured', () => {
    expect(() =>
      loadServerConfig({
        GITHUB_REPO: 'acme/docs',
        GITHUB_APP_CLIENT_ID: 'cid',
        GITHUB_APP_CLIENT_SECRET: 'sec',
        GITHUB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString('base64'),
      }),
    ).toThrow(/expected 32 bytes/);
  });
});

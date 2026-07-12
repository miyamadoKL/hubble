import { describe, expect, it } from 'vitest';
import { loadServerConfig } from './config';

describe('loadServerConfig integer bounds', () => {
  it('loads finite PostgreSQL persistence timeout defaults', () => {
    expect(
      loadServerConfig({ DATABASE_URL: 'postgres://hubble:secret@db/hubble' }).database,
    ).toEqual({
      kind: 'postgres',
      url: 'postgres://hubble:secret@db/hubble',
      timeouts: {
        connectionMs: 10_000,
        statementMs: 30_000,
        lockMs: 10_000,
        idleTransactionMs: 30_000,
        transactionMs: 60_000,
      },
    });
  });

  it('loads PostgreSQL persistence timeouts and rejects non-positive values', () => {
    const config = loadServerConfig({
      DATABASE_URL: 'postgres://hubble:secret@db/hubble',
      DATABASE_CONNECT_TIMEOUT_MS: '1200',
      DATABASE_STATEMENT_TIMEOUT_MS: '2300',
      DATABASE_LOCK_TIMEOUT_MS: '3400',
      DATABASE_IDLE_TX_TIMEOUT_MS: '4500',
      DATABASE_TRANSACTION_TIMEOUT_MS: '5600',
    });
    expect(config.database).toMatchObject({
      timeouts: {
        connectionMs: 1200,
        statementMs: 2300,
        lockMs: 3400,
        idleTransactionMs: 4500,
        transactionMs: 5600,
      },
    });

    for (const key of [
      'DATABASE_CONNECT_TIMEOUT_MS',
      'DATABASE_STATEMENT_TIMEOUT_MS',
      'DATABASE_LOCK_TIMEOUT_MS',
      'DATABASE_IDLE_TX_TIMEOUT_MS',
      'DATABASE_TRANSACTION_TIMEOUT_MS',
    ]) {
      expect(() =>
        loadServerConfig({
          DATABASE_URL: 'postgres://hubble:secret@db/hubble',
          [key]: '0',
        }),
      ).toThrow(new RegExp(key));
    }

    expect(() =>
      loadServerConfig({
        DATABASE_URL: 'postgres://hubble:secret@db/hubble',
        DATABASE_CONNECT_TIMEOUT_MS: '1.5',
      }),
    ).toThrow(/DATABASE_CONNECT_TIMEOUT_MS/);
    expect(() =>
      loadServerConfig({
        DATABASE_URL: 'postgres://hubble:secret@db/hubble',
        DATABASE_CONNECT_TIMEOUT_MS: '2147483648',
      }),
    ).toThrow(/between 1 and 2147483647/);
  });

  it('rejects QUERY_CONCURRENCY=0', () => {
    expect(() => loadServerConfig({ QUERY_CONCURRENCY: '0' })).toThrow(/minimum: 1/);
  });

  it('rejects negative QUERY_CONCURRENCY', () => {
    expect(() => loadServerConfig({ QUERY_CONCURRENCY: '-1' })).toThrow(/minimum: 1/);
  });

  it('rejects negative QUERY_MAX_ROWS', () => {
    expect(() => loadServerConfig({ QUERY_MAX_ROWS: '-100' })).toThrow(/minimum: 1/);
  });

  it('loads bounded HTTP body and query queue defaults', () => {
    const config = loadServerConfig({});
    expect(config.shutdownTimeoutMs).toBe(60_000);
    expect(config.http.maxBodyBytes).toBe(2_097_152);
    expect(config.query).toMatchObject({
      maxQueued: 100,
      maxQueuedPerPrincipal: 20,
      maxTracked: 10_000,
    });
  });

  it('rejects non-positive HTTP and query queue limits', () => {
    expect(() => loadServerConfig({ SHUTDOWN_TIMEOUT_MS: '0' })).toThrow(/minimum: 1/);
    expect(() => loadServerConfig({ HTTP_MAX_BODY_BYTES: '0' })).toThrow(/minimum: 1/);
    expect(() => loadServerConfig({ QUERY_MAX_QUEUED: '0' })).toThrow(/minimum: 1/);
    expect(() => loadServerConfig({ QUERY_MAX_QUEUED_PER_PRINCIPAL: '0' })).toThrow(/minimum: 1/);
    expect(() => loadServerConfig({ QUERY_MAX_TRACKED: '0' })).toThrow(/minimum: 1/);
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
      webhookAllowedCidrs: [],
      webhookAllowHttp: false,
      webhookTimeoutMs: 10_000,
      channelTimeoutMs: 10_000,
      smtp: {
        host: 'smtp.example.com',
        port: 465,
        user: 'hubble',
        password: 'secret',
        from: 'hubble@example.com',
      },
    });
    expect(config.alertDelivery).toEqual({
      intervalMs: 5_000,
      maxAttempts: 5,
      backoffMs: 10_000,
    });
  });

  it('loads alert delivery retry and channel timeout settings', () => {
    const config = loadServerConfig({
      ALERT_DELIVERY_INTERVAL_MS: '2500',
      ALERT_DELIVERY_MAX_ATTEMPTS: '3',
      ALERT_DELIVERY_BACKOFF_MS: '7000',
      NOTIFY_CHANNEL_TIMEOUT_MS: '9000',
    });
    expect(config.alertDelivery).toEqual({ intervalMs: 2_500, maxAttempts: 3, backoffMs: 7_000 });
    expect(config.notification.channelTimeoutMs).toBe(9_000);
  });

  it('loads table retention defaults and overrides', () => {
    expect(loadServerConfig({}).dataRetention).toEqual({
      alertDeliveryDays: 30,
      queryHistoryDays: 90,
      auditLogDays: 365,
      batchSize: 500,
    });
    expect(
      loadServerConfig({
        ALERT_DELIVERY_RETENTION_DAYS: '7',
        QUERY_HISTORY_RETENTION_DAYS: '45',
        AUDIT_LOG_RETENTION_DAYS: '730',
        DATA_RETENTION_BATCH_SIZE: '25',
      }).dataRetention,
    ).toEqual({
      alertDeliveryDays: 7,
      queryHistoryDays: 45,
      auditLogDays: 730,
      batchSize: 25,
    });
    expect(
      loadServerConfig({
        ALERT_DELIVERY_RETENTION_DAYS: '0',
        QUERY_HISTORY_RETENTION_DAYS: '0',
        AUDIT_LOG_RETENTION_DAYS: '0',
      }).dataRetention,
    ).toMatchObject({ alertDeliveryDays: 0, queryHistoryDays: 0, auditLogDays: 0 });
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
      tokenEncryptionKeys: {
        activeKeyId: 'default',
        keys: new Map([['default', Buffer.from(key, 'base64')]]),
      },
      governance: 'on',
      statusTtlSeconds: 60,
      syncCron: '0 3 * * *',
    });
  });

  it('loads an active GitHub token key ID and previous decryption keys', () => {
    const current = Buffer.alloc(32, 9).toString('base64');
    const previous = Buffer.alloc(32, 8).toString('base64');
    const github = loadServerConfig({
      GITHUB_REPO: 'acme/docs',
      GITHUB_APP_CLIENT_ID: 'cid',
      GITHUB_APP_CLIENT_SECRET: 'sec',
      GITHUB_TOKEN_ENCRYPTION_KEY: current,
      GITHUB_TOKEN_ENCRYPTION_KEY_ID: 'current',
      GITHUB_TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ previous }),
    }).github;

    expect(github.tokenEncryptionKeys?.activeKeyId).toBe('current');
    expect(github.tokenEncryptionKeys?.keys).toEqual(
      new Map([
        ['current', Buffer.from(current, 'base64')],
        ['previous', Buffer.from(previous, 'base64')],
      ]),
    );
  });

  it('rejects malformed GitHub token keyring settings', () => {
    const base = {
      GITHUB_REPO: 'acme/docs',
      GITHUB_APP_CLIENT_ID: 'cid',
      GITHUB_APP_CLIENT_SECRET: 'sec',
      GITHUB_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    };
    expect(() =>
      loadServerConfig({ ...base, GITHUB_TOKEN_ENCRYPTION_KEY_ID: 'invalid.id' }),
    ).toThrow(/GITHUB_TOKEN_ENCRYPTION_KEY_ID/);
    expect(() => loadServerConfig({ ...base, GITHUB_TOKEN_ENCRYPTION_KEYRING: '[]' })).toThrow(
      /expected a JSON object/,
    );
    expect(() =>
      loadServerConfig({
        ...base,
        GITHUB_TOKEN_ENCRYPTION_KEYRING: JSON.stringify({ old: 'short' }),
      }),
    ).toThrow(/expected 32 bytes/);
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

describe('resolveAiConfig via loadServerConfig', () => {
  it('defaults AI_PROVIDER to off', () => {
    expect(loadServerConfig({}).ai).toEqual({ provider: 'off' });
  });

  it('throws when gemini-api is enabled without GEMINI_API_KEY', () => {
    expect(() => loadServerConfig({ AI_PROVIDER: 'gemini-api' })).toThrow(/GEMINI_API_KEY/);
  });

  it('reads API key via AI_API_KEY_ENV', () => {
    expect(
      loadServerConfig({
        AI_PROVIDER: 'github-models',
        AI_API_KEY_ENV: 'CUSTOM_AI_TOKEN',
        CUSTOM_AI_TOKEN: 'token-value',
      }).ai,
    ).toEqual({
      provider: 'github-models',
      model: 'openai/gpt-4o-mini',
      apiKey: 'token-value',
      timeoutMs: 60_000,
      maxConcurrency: 4,
      perPrincipalPerMinute: 20,
      maxResponseBytes: 262_144,
      maxOutputTokens: 2_048,
    });
  });

  it('reads AI resource limit overrides', () => {
    expect(
      loadServerConfig({
        AI_PROVIDER: 'gemini-api',
        GEMINI_API_KEY: 'key',
        AI_MAX_CONCURRENCY: '2',
        AI_RATE_LIMIT_PER_MINUTE: '7',
        AI_MAX_RESPONSE_BYTES: '4096',
        AI_MAX_OUTPUT_TOKENS: '512',
      }).ai,
    ).toMatchObject({
      maxConcurrency: 2,
      perPrincipalPerMinute: 7,
      maxResponseBytes: 4_096,
      maxOutputTokens: 512,
    });
  });

  it('uses provider-specific default models', () => {
    expect(
      loadServerConfig({
        AI_PROVIDER: 'gemini-api',
        GEMINI_API_KEY: 'key',
      }).ai,
    ).toMatchObject({
      provider: 'gemini-api',
      model: 'gemini-2.5-flash',
    });
  });
});

/**
 * Webhook egress 設定の環境変数解決を確認する。
 */
import { describe, expect, it } from 'vitest';
import { loadServerConfig as loadConfig } from '../config';

const loadServerConfig = (env: Record<string, string | undefined> = {}) =>
  loadConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://hubble:test@localhost/hubble',
    ...env,
  });

describe('webhook notification config', () => {
  it('uses secure defaults', () => {
    const notification = loadServerConfig({}).notification;

    expect(notification.webhookAllowedCidrs).toEqual([]);
    expect(notification.webhookAllowHttp).toBe(false);
    expect(notification.webhookTimeoutMs).toBe(10_000);
  });

  it('loads allowed CIDRs, http permission, and timeout from env', () => {
    const notification = loadServerConfig({
      NOTIFY_WEBHOOK_ALLOWED_CIDRS: '10.0.0.0/8,fc00::/7',
      NOTIFY_WEBHOOK_ALLOW_HTTP: 'true',
      NOTIFY_WEBHOOK_TIMEOUT_MS: '2500',
    }).notification;

    expect(notification.webhookAllowedCidrs).toMatchObject([
      { version: 4, prefix: 8 },
      { version: 6, prefix: 7 },
    ]);
    expect(notification.webhookAllowHttp).toBe(true);
    expect(notification.webhookTimeoutMs).toBe(2_500);
  });
});

import nodemailer from 'nodemailer';
import { describe, expect, it, vi } from 'vitest';
import { defaultRetryPolicy } from '@hubble/contracts';
import { AuditLogger, type AuditEventInput } from '../audit';
import type { ScheduleRecord } from '../store/schedules';
import type { AlertRecord } from '../store/alerts';
import type { ServerConfig } from '../config';
import { NotificationService } from './service';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function notificationConfig(
  overrides: Partial<ServerConfig['notification']> = {},
): ServerConfig['notification'] {
  return {
    webhookAllowedCidrs: [],
    webhookAllowHttp: false,
    webhookTimeoutMs: 10_000,
    smtp: { port: 587 },
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: 'sch_1',
    owner: 'alice',
    name: 'nightly',
    statement: 'SELECT * FROM secret_table',
    catalog: 'tpch',
    schema: 'tiny',
    cron: '* * * * *',
    enabled: true,
    retry: defaultRetryPolicy,
    notifications: { onFailure: true, channels: ['slack'] },
    datasourceId: 'trino-default',
    principalSnapshot: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function input(overrides: Partial<ScheduleRecord> = {}) {
  return {
    schedule: schedule(overrides),
    runId: 'run_1',
    errorType: 'INTERNAL_ERROR',
    errorMessage: 'x'.repeat(600),
    scheduledFor: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:03.000Z',
  };
}

function auditRecorder() {
  const records: AuditEventInput[] = [];
  const audit = new AuditLogger({
    record: async (event) => {
      records.push(event);
      return 'aud_1';
    },
    listForTest: async () => [],
  });
  return { audit, records };
}

function alert(webhookUrl: string): AlertRecord {
  return {
    id: 'alt_1',
    owner: 'alice',
    name: 'high rows',
    savedQueryId: 'qry_1',
    columnName: 'row_count',
    op: '>',
    value: '100',
    selector: 'first',
    rearm: 0,
    muted: false,
    cron: '* * * * *',
    state: 'triggered',
    lastTriggeredAt: null,
    notifications: { channels: ['webhook'], webhookUrl },
    principalSnapshot: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('NotificationService', () => {
  it('sends Slack via fetch and records a success audit row', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
    const { audit, records } = auditRecorder();
    const service = new NotificationService(
      notificationConfig({
        slackWebhookUrl: 'https://hooks.slack.test/services/T',
      }),
      { fetchImpl, audit, webhookLookup: PUBLIC_LOOKUP },
    );

    await service.sendFailure(input());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://hooks.slack.test/services/T');
    const body = JSON.parse(String((init as unknown as RequestInit).body)) as { text: string };
    expect(body.text).toContain('Schedule: nightly');
    expect(body.text).toContain('Datasource: trino-default');
    expect(body.text).toContain('Owner: alice');
    expect(body.text).not.toContain('secret_table');
    const reason = body.text.split('Reason: ')[1] ?? '';
    expect(reason.match(/x/g)?.length).toBe(500);
    expect(records[0]).toMatchObject({
      actor: 'alice',
      action: 'notification.send',
      target: 'sch_1',
      datasource: 'trino-default',
      detail: {
        scheduleId: 'sch_1',
        runId: 'run_1',
        channel: 'slack',
        success: true,
        outcome: 'sent',
      },
    });
  });

  it('truncates the failure reason by code point', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
    const service = new NotificationService(
      notificationConfig({
        slackWebhookUrl: 'https://hooks.slack.test/services/T',
      }),
      { fetchImpl, webhookLookup: PUBLIC_LOOKUP },
    );

    await service.sendFailure({ ...input(), errorMessage: '😀'.repeat(501) });

    const [, init] = fetchImpl.mock.calls[0]!;
    const body = JSON.parse(String((init as unknown as RequestInit).body)) as { text: string };
    const reason = body.text.split('Reason: ')[1] ?? '';
    expect(Array.from(reason)).toHaveLength(500);
    expect(reason).not.toContain('�');
  });

  it('sends email through an injected transport only when email is selected', async () => {
    const sendMail = vi.fn(async () => ({}));
    const fetchImpl = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200 }) as Response);
    const service = new NotificationService(
      notificationConfig({
        slackWebhookUrl: 'https://hooks.slack.test/services/T',
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          user: 'hubble',
          password: 'secret',
          from: 'hubble@example.com',
        },
      }),
      { fetchImpl, mailSender: { sendMail } },
    );

    await service.sendFailure(
      input({
        notifications: {
          onFailure: true,
          channels: ['email'],
          emailTo: ['ops@example.com', 'data@example.com'],
        },
      }),
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'hubble@example.com',
        to: ['ops@example.com', 'data@example.com'],
        subject: '[Hubble] Schedule failed: nightly',
      }),
    );
  });

  it('warns, skips, and audits failure when a requested channel is not configured', async () => {
    const logWarn = vi.fn();
    const { audit, records } = auditRecorder();
    const service = new NotificationService(notificationConfig(), { audit, logWarn });

    await service.sendFailure(input());

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(records[0]).toMatchObject({
      action: 'notification.send',
      detail: {
        channel: 'slack',
        success: false,
        outcome: 'skipped',
        error: 'NOT_CONFIGURED',
      },
    });
  });

  it('rejects a private alert webhook before POST and records a failed audit row', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const { audit, records } = auditRecorder();
    const service = new NotificationService(notificationConfig(), { fetchImpl, audit });

    await service.sendAlertTriggered({
      alert: alert('https://127.0.0.1/hook'),
      outcome: {
        state: 'triggered',
        previousState: 'ok',
        conditionMet: true,
        observedValue: '101',
        notified: true,
        errorType: null,
        errorMessage: null,
      },
      savedQueryName: 'row count',
      datasourceId: 'trino-default',
      evaluatedAt: '2026-01-01T00:00:00.000Z',
    });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(records[0]).toMatchObject({
      action: 'notification.send',
      detail: {
        channel: 'webhook',
        success: false,
        outcome: 'failed',
        error: 'Webhook destination is not allowed',
      },
    });
  });

  it('imports nodemailer and creates a transport without sending mail', () => {
    expect(typeof nodemailer.createTransport).toBe('function');
    const transport = nodemailer.createTransport({ streamTransport: true });
    expect(typeof transport.sendMail).toBe('function');
  });
});

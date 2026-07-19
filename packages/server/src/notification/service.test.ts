import nodemailer from 'nodemailer';
import http from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { defaultRetryPolicy } from '@hubble/contracts';
import { AuditLogger, type AuditEventInput } from '../audit';
import type { ScheduleRecord } from '../store/schedules';
import type { AlertRecord } from '../store/alerts';
import type { ServerConfig } from '../config';
import { parseCidrList } from '../auth/cidr';
import type { SafeFetch } from './safeFetch';
import { NotificationService } from './service';

const PUBLIC_LOOKUP = async () => [{ address: '93.184.216.34', family: 4 }];

function notificationConfig(
  overrides: Partial<ServerConfig['notification']> = {},
): ServerConfig['notification'] {
  return {
    webhookAllowedCidrs: [],
    webhookAllowHttp: false,
    webhookTimeoutMs: 10_000,
    channelTimeoutMs: 10_000,
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
    savedQueryId: null,
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

function alertInput(webhookUrl: string) {
  return {
    alert: alert(webhookUrl),
    outcome: {
      state: 'triggered' as const,
      previousState: 'ok' as const,
      conditionMet: true,
      observedValue: '101',
      notified: true,
      errorType: null,
      errorMessage: null,
    },
    savedQueryName: 'row count',
    datasourceId: 'trino-default',
    evaluatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function serviceSafeFetch(service: NotificationService): SafeFetch {
  return (service as unknown as { fetchImpl: SafeFetch }).fetchImpl;
}

describe('NotificationService', () => {
  it('sends Slack via fetch and records a success audit row', async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = vi.fn<typeof fetch>(
      async () => ({ ok: true, status: 200, body: { cancel } }) as unknown as Response,
    );
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
    expect(cancel).toHaveBeenCalledOnce();
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

  it('Slack非2xxでもbodyを解放し、元のHTTP errorを監査する', async () => {
    const cancel = vi.fn(async () => {
      throw new Error('cancel failed');
    });
    const fetchImpl = vi.fn<typeof fetch>(
      async () => ({ ok: false, status: 503, body: { cancel } }) as unknown as Response,
    );
    const logWarn = vi.fn();
    const { audit, records } = auditRecorder();
    const service = new NotificationService(
      notificationConfig({ slackWebhookUrl: 'https://hooks.slack.test/services/T' }),
      { fetchImpl, audit, logWarn, webhookLookup: PUBLIC_LOOKUP },
    );

    await service.sendFailure(input());

    expect(cancel).toHaveBeenCalledOnce();
    expect(logWarn).toHaveBeenCalledWith(
      'notification send skipped or failed: channel=slack',
      expect.objectContaining({ message: 'Slack webhook returned 503' }),
    );
    expect(records[0]).toMatchObject({
      action: 'notification.send',
      detail: {
        channel: 'slack',
        success: false,
        outcome: 'failed',
        error: 'Slack webhook returned 503',
      },
    });
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

    await service.sendAlertTriggered(alertInput('https://127.0.0.1/hook'));

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

  it('body cancel失敗でwebhookの元の成功またはHTTP errorを覆さない', async () => {
    const cancelSuccess = vi.fn(async () => {
      throw new Error('success cancel failed');
    });
    const cancelFailure = vi.fn(async () => {
      throw new Error('failure cancel failed');
    });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        body: { cancel: cancelSuccess },
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 503,
        body: { cancel: cancelFailure },
      } as unknown as Response);
    const service = new NotificationService(notificationConfig(), {
      fetchImpl,
      webhookLookup: PUBLIC_LOOKUP,
    });
    const input = alertInput('https://hooks.example.com/alert');

    await expect(service.sendChannel('webhook', input)).resolves.toBeUndefined();
    await expect(service.sendChannel('webhook', input)).rejects.toThrow('Webhook returned 503');
    expect(cancelSuccess).toHaveBeenCalledOnce();
    expect(cancelFailure).toHaveBeenCalledOnce();
  });

  it('遅いchunked webhookを複数送信してもsocket数が通知件数に比例しない', async () => {
    const sockets = new Set<Socket>();
    let maxSockets = 0;
    const server = http.createServer((request, response) => {
      request.resume();
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.write('accepted');
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      maxSockets = Math.max(maxSockets, sockets.size);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not start');
    const url = `http://127.0.0.1:${address.port}/hook`;
    const service = new NotificationService(
      notificationConfig({
        webhookAllowedCidrs: parseCidrList('127.0.0.0/8'),
        webhookAllowHttp: true,
        webhookTimeoutMs: 2_000,
      }),
    );

    try {
      for (let index = 0; index < 12; index += 1) {
        await service.sendChannel('webhook', alertInput(url));
      }
      await vi.waitFor(() => expect(sockets.size).toBe(0));
      expect(maxSockets).toBeLessThanOrEqual(2);
    } finally {
      await service.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('imports nodemailer and creates a transport without sending mail', () => {
    expect(typeof nodemailer.createTransport).toBe('function');
    const transport = nodemailer.createTransport({ streamTransport: true });
    expect(typeof transport.sendMail).toBe('function');
  });

  it('closes SafeFetch but leaves an injected mail sender owned by its caller', async () => {
    const sendMail = vi.fn(async () => ({}));
    const closeMail = vi.fn();
    const service = new NotificationService(
      notificationConfig({
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          from: 'hubble@example.com',
        },
      }),
      { mailSender: { sendMail, close: closeMail } },
    );
    await service.sendFailure(
      input({
        notifications: {
          onFailure: true,
          channels: ['email'],
          emailTo: ['ops@example.com'],
        },
      }),
    );
    const closeSafeFetch = vi.spyOn(serviceSafeFetch(service), 'close');

    await service.close();
    await service.close();

    expect(closeSafeFetch).toHaveBeenCalledOnce();
    expect(closeMail).not.toHaveBeenCalled();
  });

  it('attempts both owned resource closes and reports their failures together', async () => {
    const sendMail = vi.fn(async () => ({}));
    const closeMail = vi.fn(() => {
      throw new Error('smtp close failed');
    });
    const createTransport = vi
      .spyOn(nodemailer, 'createTransport')
      .mockReturnValue({ sendMail, close: closeMail } as never);
    const service = new NotificationService(
      notificationConfig({
        smtp: {
          host: 'smtp.example.com',
          port: 587,
          from: 'hubble@example.com',
        },
      }),
    );
    await service.sendFailure(
      input({
        notifications: {
          onFailure: true,
          channels: ['email'],
          emailTo: ['ops@example.com'],
        },
      }),
    );
    const safeFetch = serviceSafeFetch(service);
    const originalClose = safeFetch.close.bind(safeFetch);
    const closeSafeFetch = vi
      .spyOn(safeFetch, 'close')
      .mockRejectedValue(new Error('safe fetch close failed'));

    try {
      const closing = service.close();
      await expect(closing).rejects.toMatchObject({
        errors: [
          expect.objectContaining({ message: 'safe fetch close failed' }),
          expect.objectContaining({ message: 'smtp close failed' }),
        ],
      });
      await expect(service.close()).rejects.toThrow('Notification service resource close failed');
      expect(closeSafeFetch).toHaveBeenCalledOnce();
      expect(closeMail).toHaveBeenCalledOnce();
    } finally {
      createTransport.mockRestore();
      await originalClose();
    }
  });

  it('rejects a single email channel when the Hubble deadline expires', async () => {
    vi.useFakeTimers();
    try {
      const sendMail = vi.fn(() => new Promise<never>(() => {}));
      const service = new NotificationService(
        notificationConfig({
          channelTimeoutMs: 25,
          smtp: {
            host: 'smtp.example.com',
            port: 587,
            from: 'hubble@example.com',
          },
        }),
        { mailSender: { sendMail } },
      );
      const emailAlert: AlertRecord = {
        ...alert('https://example.com/unused'),
        notifications: { channels: ['email'], emailTo: ['ops@example.com'] },
      };
      const pending = service.sendChannel('email', {
        alert: emailAlert,
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
      const rejected = expect(pending).rejects.toThrow('Email send timed out');

      await vi.advanceTimersByTimeAsync(25);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});

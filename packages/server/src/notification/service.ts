/**
 * スケジュール失敗通知とAlert発火通知を外部チャネルへ送るサービス層。
 * 各チャネルの送信処理、監査ログ記録、失敗時のwarnログをここに閉じ込める。
 */
import nodemailer from 'nodemailer';
import type { ScheduleNotificationChannel, AlertNotificationChannel } from '@hubble/contracts';
import type { ServerConfig } from '../config';
import type { ScheduleRecord } from '../store/schedules';
import type { AlertRecord } from '../store/alerts';
import type { AlertEvalResponse } from '@hubble/contracts';
import type { AuditJson, AuditLogger } from '../audit';
import { createSafeFetch, type SafeFetch, type SafeFetchOptions } from './safeFetch';

interface MailSender {
  sendMail(message: {
    from: string;
    to: string[];
    subject: string;
    text: string;
  }): Promise<unknown>;
}

export interface FailureNotificationInput {
  /** 失敗が確定したスケジュール。 */
  schedule: ScheduleRecord;
  /** 失敗した run の id。 */
  runId: string;
  /** エンジンまたは実行基盤から得たエラー種別。 */
  errorType: string | null;
  /** 通知本文に載せる失敗理由。本文側で上限文字数に切り詰める。 */
  errorMessage: string | null;
  /** cron 上の予定実行時刻。 */
  scheduledFor: string;
  /** run が失敗として確定した時刻。 */
  finishedAt: string;
}

/** スケジューラーから見た失敗通知送信の抽象。 */
export interface FailureNotificationSender {
  /** 確定失敗した run の通知を送信する。 */
  sendFailure(input: FailureNotificationInput): Promise<void>;
}

export interface AlertTriggeredNotificationInput {
  alert: AlertRecord;
  outcome: AlertEvalResponse;
  savedQueryName: string;
  datasourceId: string;
  evaluatedAt: string;
}

/** 既存呼び出しから見たAlert発火通知送信の抽象。 */
export interface AlertNotificationSender {
  sendAlertTriggered(input: AlertTriggeredNotificationInput): Promise<void>;
}

/** Alert outbox workerから見た単一チャネル配送の抽象。 */
export interface AlertChannelNotificationSender {
  sendChannel(
    channel: AlertNotificationChannel,
    input: AlertTriggeredNotificationInput,
  ): Promise<void>;
}

/** 通知サービスの外部依存。テストでは fetch、メール送信、監査ログを差し替える。 */
export interface NotificationServiceDeps {
  /** Slack webhook 呼び出しに使う fetch 実装。 */
  fetchImpl?: typeof fetch;
  /** webhook の事前 DNS 解決を差し替えるテスト用関数。 */
  webhookLookup?: SafeFetchOptions['lookup'];
  /** webhook の接続時 DNS 解決を差し替えるテスト用関数。 */
  webhookConnectionLookup?: SafeFetchOptions['connectionLookup'];
  /** email 送信に使う transport。未指定時は nodemailer から作る。 */
  mailSender?: MailSender;
  /** 通知送信結果を記録する監査ログ。 */
  audit?: AuditLogger;
  /** 通知失敗時の warn ログ出力。 */
  logWarn?: (message: string, detail?: unknown) => void;
}

const MAX_REASON_LENGTH = 500;

/**
 * スケジュール失敗時の外部通知を送るサービス。
 */
export class NotificationService
  implements FailureNotificationSender, AlertNotificationSender, AlertChannelNotificationSender
{
  private readonly fetchImpl: SafeFetch;
  private readonly logWarn: (message: string, detail?: unknown) => void;
  private mailSender?: MailSender;

  constructor(
    private readonly config: ServerConfig['notification'],
    private readonly deps: NotificationServiceDeps = {},
  ) {
    this.fetchImpl = createSafeFetch({
      fetchImpl: deps.fetchImpl,
      allowedCidrs: config.webhookAllowedCidrs,
      allowHttp: config.webhookAllowHttp,
      timeoutMs: config.webhookTimeoutMs,
      lookup: deps.webhookLookup,
      connectionLookup: deps.webhookConnectionLookup,
    });
    this.logWarn = deps.logWarn ?? ((message, detail) => console.warn(message, detail));
    this.mailSender = deps.mailSender;
  }

  async sendFailure(input: FailureNotificationInput): Promise<void> {
    const notifications = input.schedule.notifications;
    if (!notifications.onFailure) return;
    for (const channel of notifications.channels) {
      await this.sendScheduleChannel(channel, input);
    }
  }

  async sendAlertTriggered(input: AlertTriggeredNotificationInput): Promise<void> {
    for (const channel of input.alert.notifications.channels) {
      try {
        await this.sendChannel(channel, input);
      } catch (err) {
        this.logWarn(`alert notification send skipped or failed: channel=${channel}`, err);
      }
    }
  }

  /** 単一Alertチャネルを配送し、失敗時はworkerが再試行できるよう例外を返す。 */
  async sendChannel(
    channel: AlertNotificationChannel,
    input: AlertTriggeredNotificationInput,
  ): Promise<void> {
    const text = this.renderAlertText(input);
    try {
      if (channel === 'slack') {
        await this.sendSlack(this.config.slackWebhookUrl, text);
      } else if (channel === 'email') {
        await this.sendEmail(
          input.alert.notifications.emailTo ?? [],
          `[Hubble] Alert triggered: ${input.alert.name}`,
          text,
        );
      } else {
        await this.sendWebhook(input.alert.notifications.webhookUrl!, text, input);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.recordAlertAuditBestEffort(input, channel, false, {
        outcome: message === 'NOT_CONFIGURED' ? 'skipped' : 'failed',
        error: message,
      });
      throw err;
    }
    await this.recordAlertAuditBestEffort(input, channel, true, { outcome: 'sent' });
  }

  private async sendScheduleChannel(
    channel: ScheduleNotificationChannel,
    input: FailureNotificationInput,
  ): Promise<void> {
    try {
      if (channel === 'slack') {
        await this.sendSlack(this.config.slackWebhookUrl, this.renderFailureText(input));
      } else {
        await this.sendEmail(
          input.schedule.notifications.emailTo ?? [],
          `[Hubble] Schedule failed: ${input.schedule.name}`,
          this.renderFailureText(input),
        );
      }
      await this.recordScheduleAudit(input, channel, true, { outcome: 'sent' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logWarn(`notification send skipped or failed: channel=${channel}`, err);
      await this.recordScheduleAudit(input, channel, false, {
        outcome: message === 'NOT_CONFIGURED' ? 'skipped' : 'failed',
        error: message,
      });
    }
  }

  private async sendSlack(webhookUrl: string | undefined, text: string): Promise<void> {
    if (!webhookUrl) throw new Error('NOT_CONFIGURED');
    const res = await this.fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook returned ${res.status}`);
    }
  }

  private async sendEmail(to: string[], subject: string, text: string): Promise<void> {
    const { host, port, user, password, from } = this.config.smtp;
    if (!host || !from) throw new Error('NOT_CONFIGURED');
    if (to.length === 0) throw new Error('NOT_CONFIGURED');
    const sender = this.mailSender ?? this.createMailSender(host, port, user, password);
    await withTimeout(
      sender.sendMail({ from, to, subject, text }),
      this.config.channelTimeoutMs,
      'Email send timed out',
    );
  }

  private async sendWebhook(
    webhookUrl: string,
    text: string,
    input: AlertTriggeredNotificationInput,
  ): Promise<void> {
    const res = await this.fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        alert: {
          id: input.alert.id,
          name: input.alert.name,
          state: input.outcome.state,
          observedValue: input.outcome.observedValue,
          savedQueryId: input.alert.savedQueryId,
          savedQueryName: input.savedQueryName,
          evaluatedAt: input.evaluatedAt,
        },
      }),
    });
    if (!res.ok) {
      throw new Error(`Webhook returned ${res.status}`);
    }
  }

  private createMailSender(
    host: string,
    port: number,
    user: string | undefined,
    password: string | undefined,
  ): MailSender {
    const auth = user ? { user, pass: password } : undefined;
    this.mailSender = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      ...(auth ? { auth } : {}),
    });
    return this.mailSender;
  }

  private renderFailureText(input: FailureNotificationInput): string {
    const reason = truncate(input.errorMessage ?? input.errorType ?? 'Unknown failure');
    return [
      'Hubble schedule failed',
      `Schedule: ${input.schedule.name}`,
      `Datasource: ${input.schedule.datasourceId}`,
      `Owner: ${input.schedule.owner}`,
      `Execution time: ${input.scheduledFor}`,
      `Finished at: ${input.finishedAt}`,
      `Run: ${input.runId}`,
      `Reason: ${reason}`,
    ].join('\n');
  }

  private renderAlertText(input: AlertTriggeredNotificationInput): string {
    return [
      'Hubble alert triggered',
      `Alert: ${input.alert.name}`,
      `Saved query: ${input.savedQueryName}`,
      `Datasource: ${input.datasourceId}`,
      `Owner: ${input.alert.owner}`,
      `Column: ${input.alert.columnName} ${input.alert.op} ${input.alert.value}`,
      `Observed: ${input.outcome.observedValue ?? 'n/a'}`,
      `State: ${input.outcome.previousState} → ${input.outcome.state}`,
      `Evaluated at: ${input.evaluatedAt}`,
    ].join('\n');
  }

  private async recordScheduleAudit(
    input: FailureNotificationInput,
    channel: ScheduleNotificationChannel,
    success: boolean,
    extra: Record<string, AuditJson>,
  ): Promise<void> {
    await this.deps.audit?.record({
      actor: input.schedule.owner,
      action: 'notification.send',
      target: input.schedule.id,
      datasource: input.schedule.datasourceId,
      detail: {
        scheduleId: input.schedule.id,
        runId: input.runId,
        channel,
        success,
        notificationType: 'schedule_failure',
        ...extra,
      },
    });
  }

  private async recordAlertAudit(
    input: AlertTriggeredNotificationInput,
    channel: AlertNotificationChannel,
    success: boolean,
    extra: Record<string, AuditJson>,
  ): Promise<void> {
    await this.deps.audit?.record({
      actor: input.alert.owner,
      action: 'notification.send',
      target: input.alert.id,
      datasource: input.datasourceId,
      detail: {
        alertId: input.alert.id,
        channel,
        success,
        notificationType: 'alert_triggered',
        ...extra,
      },
    });
  }

  private async recordAlertAuditBestEffort(
    input: AlertTriggeredNotificationInput,
    channel: AlertNotificationChannel,
    success: boolean,
    extra: Record<string, AuditJson>,
  ): Promise<void> {
    try {
      await this.recordAlertAudit(input, channel, success, extra);
    } catch (err) {
      // 監査失敗による再配送は重複通知になるため、配送結果は覆さない。
      this.logWarn(`alert notification audit failed: channel=${channel}`, err);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(message)), timeoutMs);
    handle.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

function truncate(value: string): string {
  const chars = Array.from(value);
  return chars.length > MAX_REASON_LENGTH ? chars.slice(0, MAX_REASON_LENGTH).join('') : value;
}

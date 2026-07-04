/**
 * スケジュール失敗通知を外部チャネルへ送るサービス層。
 * スケジューラーから確定失敗だけを受け取り、Slack と email の送信処理、監査ログ記録、失敗時の warn ログをここに閉じ込める。
 */
import nodemailer from 'nodemailer';
import type { ScheduleNotificationChannel } from '@hubble/contracts';
import type { ServerConfig } from '../config';
import type { ScheduleRecord } from '../store/schedules';
import type { AuditJson, AuditLogger } from '../audit';

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

/** 通知サービスの外部依存。テストでは fetch、メール送信、監査ログを差し替える。 */
export interface NotificationServiceDeps {
  /** Slack webhook 呼び出しに使う fetch 実装。 */
  fetchImpl?: typeof fetch;
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
export class NotificationService implements FailureNotificationSender {
  private readonly fetchImpl: typeof fetch;
  private readonly logWarn: (message: string, detail?: unknown) => void;
  private mailSender?: MailSender;

  constructor(
    private readonly config: ServerConfig['notification'],
    private readonly deps: NotificationServiceDeps = {},
  ) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.logWarn = deps.logWarn ?? ((message, detail) => console.warn(message, detail));
    this.mailSender = deps.mailSender;
  }

  async sendFailure(input: FailureNotificationInput): Promise<void> {
    const notifications = input.schedule.notifications;
    if (!notifications.onFailure) return;
    for (const channel of notifications.channels) {
      await this.sendChannel(channel, input);
    }
  }

  private async sendChannel(
    channel: ScheduleNotificationChannel,
    input: FailureNotificationInput,
  ): Promise<void> {
    try {
      if (channel === 'slack') {
        await this.sendSlack(input);
      } else {
        await this.sendEmail(input);
      }
      await this.recordAudit(input, channel, true, { outcome: 'sent' });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logWarn(`notification send skipped or failed: channel=${channel}`, err);
      await this.recordAudit(input, channel, false, {
        outcome: message === 'NOT_CONFIGURED' ? 'skipped' : 'failed',
        error: message,
      });
    }
  }

  private async sendSlack(input: FailureNotificationInput): Promise<void> {
    const webhookUrl = this.config.slackWebhookUrl;
    if (!webhookUrl) throw new Error('NOT_CONFIGURED');
    const res = await this.fetchImpl(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: this.renderText(input) }),
    });
    if (!res.ok) {
      throw new Error(`Slack webhook returned ${res.status}`);
    }
  }

  private async sendEmail(input: FailureNotificationInput): Promise<void> {
    const { host, port, user, password, from } = this.config.smtp;
    if (!host || !from) throw new Error('NOT_CONFIGURED');
    const to = input.schedule.notifications.emailTo ?? [];
    if (to.length === 0) throw new Error('NOT_CONFIGURED');
    const sender = this.mailSender ?? this.createMailSender(host, port, user, password);
    await sender.sendMail({
      from,
      to,
      subject: `[Hubble] Schedule failed: ${input.schedule.name}`,
      text: this.renderText(input),
    });
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

  private renderText(input: FailureNotificationInput): string {
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

  private async recordAudit(
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
}

function truncate(value: string): string {
  const chars = Array.from(value);
  return chars.length > MAX_REASON_LENGTH ? chars.slice(0, MAX_REASON_LENGTH).join('') : value;
}

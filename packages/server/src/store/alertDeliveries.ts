/**
 * Alert通知配信outboxの永続化層。
 */
import type { AlertNotificationChannel } from '@hubble/contracts';
import type { SqlDatabase } from '../db/sqlDatabase';
import type { AlertTriggeredNotificationInput } from '../notification/service';
import { newId } from '../util/id';

export type AlertDeliveryStatus = 'pending' | 'sent' | 'dead';

export interface AlertDeliveryJob {
  id: string;
  alertId: string;
  owner: string;
  channel: AlertNotificationChannel;
  payload: AlertTriggeredNotificationInput;
  status: AlertDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface InsertAlertDeliveryInput {
  alertId: string;
  owner: string;
  channel: AlertNotificationChannel;
  payload: AlertTriggeredNotificationInput;
  nextAttemptAt: string;
}

interface AlertDeliveryRow {
  id: string;
  alert_id: string;
  owner: string;
  channel: string;
  payload: string;
  status: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

function rowToJob(row: AlertDeliveryRow): AlertDeliveryJob {
  return {
    id: row.id,
    alertId: row.alert_id,
    owner: row.owner,
    channel: row.channel as AlertNotificationChannel,
    payload: JSON.parse(row.payload) as AlertTriggeredNotificationInput,
    status: row.status as AlertDeliveryStatus,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Alert通知配信ジョブを管理するrepository。 */
export class AlertDeliveryRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** pendingジョブを1件追加する。 */
  async insert(input: InsertAlertDeliveryInput, nowIso = input.nextAttemptAt): Promise<string> {
    const id = newId('ald_');
    await this.db.run(
      `INSERT INTO alert_deliveries
       (id, alert_id, owner, channel, payload, status, attempts, next_attempt_at,
        last_error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        input.alertId,
        input.owner,
        input.channel,
        JSON.stringify(input.payload),
        'pending',
        0,
        input.nextAttemptAt,
        null,
        nowIso,
        nowIso,
      ],
    );
    return id;
  }

  /**
   * 配信時刻を迎えたpendingジョブを返す。
   * 単一プロセスではworkerがtickを直列化する。マルチインスタンスでは分散lockとleaseが必要。
   */
  async claimDue(nowIso: string, limit: number): Promise<AlertDeliveryJob[]> {
    const rows = await this.db.query<AlertDeliveryRow>(
      `SELECT * FROM alert_deliveries
       WHERE status = $1 AND next_attempt_at <= $2
       ORDER BY next_attempt_at ASC, id ASC
       LIMIT $3`,
      ['pending', nowIso, limit],
    );
    return rows.map(rowToJob);
  }

  /** 配信成功として確定する。 */
  async markSent(id: string, nowIso: string): Promise<void> {
    await this.db.run(
      `UPDATE alert_deliveries
       SET status = $1, last_error = NULL, updated_at = $2
       WHERE id = $3 AND status = $4`,
      ['sent', nowIso, id, 'pending'],
    );
  }

  /** 次の試行時刻と失敗理由を記録する。 */
  async markRetry(
    id: string,
    attempts: number,
    nextAttemptAtIso: string,
    error: string,
    nowIso: string,
  ): Promise<void> {
    await this.db.run(
      `UPDATE alert_deliveries
       SET attempts = $1, next_attempt_at = $2, last_error = $3, updated_at = $4
       WHERE id = $5 AND status = $6`,
      [attempts, nextAttemptAtIso, error, nowIso, id, 'pending'],
    );
  }

  /** 再試行上限へ達したジョブをdeadとして確定する。 */
  async markDead(id: string, attempts: number, error: string, nowIso: string): Promise<void> {
    await this.db.run(
      `UPDATE alert_deliveries
       SET status = $1, attempts = $2, last_error = $3, updated_at = $4
       WHERE id = $5 AND status = $6`,
      ['dead', attempts, error, nowIso, id, 'pending'],
    );
  }

  /** 保持期限を過ぎた sent と dead のジョブを古い順にページ削除する。 */
  async pruneTerminalBefore(cutoffIso: string, limit: number): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      `DELETE FROM alert_deliveries
       WHERE id IN (
         SELECT id FROM alert_deliveries
         WHERE status IN ('sent', 'dead') AND updated_at < $1
         ORDER BY updated_at ASC, id ASC
         LIMIT $2
       )
       RETURNING id`,
      [cutoffIso, limit],
    );
    return rows.length;
  }

  /** テストと運用確認用に全ジョブを作成順で返す。 */
  async listForTest(): Promise<AlertDeliveryJob[]> {
    const rows = await this.db.query<AlertDeliveryRow>(
      'SELECT * FROM alert_deliveries ORDER BY created_at ASC, id ASC',
    );
    return rows.map(rowToJob);
  }
}

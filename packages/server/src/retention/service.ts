/** 永続テーブルの保持期限を日次で適用するサービス。 */
import type { AuditRepository } from '../audit';
import type { AlertDeliveryRepository } from '../store/alertDeliveries';
import type { HistoryRepository } from '../store/history';
import { PeriodicRunner, type PeriodicTimerFactory } from '../util/periodicRunner';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** DataRetentionService が適用するテーブル別保持設定。 */
export interface DataRetentionPolicy {
  alertDeliveryDays: number;
  queryHistoryDays: number;
  auditLogDays: number;
  batchSize: number;
}

/** DataRetentionService の依存とテスト用注入点。 */
export interface DataRetentionServiceOptions {
  alertDeliveries: AlertDeliveryRepository;
  history: HistoryRepository;
  audit: AuditRepository;
  policy: DataRetentionPolicy;
  now?: () => number;
  logWarn?: (message: string, error: unknown) => void;
  setTimer?: PeriodicTimerFactory;
}

/** Alert outbox、query history、audit log をページ単位で日次削除する。 */
export class DataRetentionService {
  private readonly periodic: PeriodicRunner;

  constructor(private readonly options: DataRetentionServiceOptions) {
    this.periodic = new PeriodicRunner({
      intervalMs: DAY_MS,
      task: () => this.applyPolicies(),
      logError: (message, error) => {
        if (this.options.logWarn) this.options.logWarn(message, error);
        else console.warn(message, error);
      },
      errorMessage: 'data retention: periodic cleanup failed',
      runImmediately: true,
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    });
  }

  /** 起動直後の削除を投げ、日次 timer を開始する。 */
  start(): void {
    this.periodic.start();
  }

  /** 新しい timer を止め、進行中のページ削除を待つ。 */
  async stop(): Promise<void> {
    await this.periodic.stop();
  }

  /** テストと運用上の明示実行向けに、重複しない cleanup を1回走らせる。 */
  runOnce(): Promise<void> {
    return this.periodic.runNow();
  }

  private async applyPolicies(): Promise<void> {
    const now = this.options.now?.() ?? Date.now();
    const { policy } = this.options;
    const errors: unknown[] = [];
    const policies: Array<() => Promise<void>> = [];
    if (policy.alertDeliveryDays > 0) {
      policies.push(() =>
        this.prunePages((limit) =>
          this.options.alertDeliveries.pruneTerminalBefore(
            cutoffIso(now, policy.alertDeliveryDays),
            limit,
          ),
        ),
      );
    }
    if (policy.queryHistoryDays > 0) {
      policies.push(() =>
        this.prunePages((limit) =>
          this.options.history.pruneBefore(cutoffIso(now, policy.queryHistoryDays), limit),
        ),
      );
    }
    if (policy.auditLogDays > 0) {
      policies.push(() =>
        this.prunePages((limit) =>
          this.options.audit.pruneBefore(cutoffIso(now, policy.auditLogDays), limit),
        ),
      );
    }
    for (const apply of policies) {
      try {
        await apply();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, 'Data retention cleanup failed');
  }

  private async prunePages(prune: (limit: number) => Promise<number>): Promise<void> {
    while ((await prune(this.options.policy.batchSize)) === this.options.policy.batchSize) {
      // 1回の transaction と lock 保持時間を batchSize 行以内に抑え、残りは次の文で続行する。
    }
  }
}

function cutoffIso(now: number, days: number): string {
  return new Date(now - days * DAY_MS).toISOString();
}

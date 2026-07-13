/**
 * 期限切れ JSONL 結果オブジェクトと、参照削除済みの結果オブジェクトを削除するサービス。
 */
import type { ExpiredHistoryResult, HistoryRepository } from '../store/history';
import type {
  ResultObjectDeletionJob,
  ResultObjectDeletionRepository,
} from '../store/resultObjectDeletions';
import type { ExpiredWorkflowStepResult, WorkflowRunRepository } from '../store/workflows';
import type { ResultStore } from './store';
import { PeriodicRunner } from '../util/periodicRunner';

const DAY_MS = 24 * 60 * 60 * 1000;
const REFERENCE_EXPIRY_PAGE_SIZE = 100;
const DELETION_CLAIM_LIMIT = 100;
const DELETION_RETRY_BASE_MS = 60_000;

/** ResultExpiryService の生成オプション。 */
export interface ResultExpiryServiceOptions {
  history: HistoryRepository;
  workflowRuns: WorkflowRunRepository;
  deletions: ResultObjectDeletionRepository;
  resultStore: ResultStore;
  now?: () => number;
  logWarn?: (message: string, err?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

/** 起動時と日次で期限切れ result を消し、短周期の削除 outbox も直列実行するサービス。 */
export class ResultExpiryService {
  private readonly expiryPeriodic: PeriodicRunner;
  private readonly deletionPeriodic: PeriodicRunner;
  private operationTail: Promise<void> = Promise.resolve();
  private disabledWarningLogged = false;

  constructor(private readonly options: ResultExpiryServiceOptions) {
    this.expiryPeriodic = new PeriodicRunner({
      intervalMs: DAY_MS,
      task: () => this.serialize(() => this.runReferenceExpiry()),
      logError: (message, error) => {
        if (this.options.logWarn) this.options.logWarn(message, error);
        else console.warn(message, error);
      },
      errorMessage: 'result expiry: periodic cleanup failed',
      runImmediately: true,
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    });
    this.deletionPeriodic = new PeriodicRunner({
      intervalMs: DELETION_RETRY_BASE_MS,
      task: () => this.serialize(() => this.runDeletionOutbox()),
      logError: (message, error) => {
        if (this.options.logWarn) this.options.logWarn(message, error);
        else console.warn(message, error);
      },
      errorMessage: 'result deletion outbox: periodic cleanup failed',
      runImmediately: true,
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    });
  }

  /** 起動時掃除を投げ、日次 expiry と短周期 outbox の timer を開始する。 */
  start(): void {
    this.expiryPeriodic.start();
    this.deletionPeriodic.start();
  }

  /** 両 timer を停止し、直列 queue 上で進行中の掃除を待つ。 */
  async stop(): Promise<void> {
    await Promise.allSettled([this.expiryPeriodic.stop(), this.deletionPeriodic.stop()]);
    await this.operationTail;
  }

  /** 期限切れオブジェクトを削除して DB の key を NULL 化し、削除 outbox も直列処理する。 */
  async runOnce(): Promise<void> {
    await this.serialize(async () => {
      await this.runReferenceExpiry();
      await this.runDeletionOutbox();
    });
  }

  private serialize(task: () => Promise<void>): Promise<void> {
    const operation = this.operationTail.then(task, task);
    this.operationTail = operation.catch(() => undefined);
    return operation;
  }

  private async runReferenceExpiry(): Promise<void> {
    if (!this.options.resultStore.enabled) return;
    const nowMs = this.options.now?.() ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    let historyAfter: { resultExpiresAt: string; id: string } | undefined;
    let workflowAfter: { resultExpiresAt: string; id: string } | undefined;
    let historyDone = false;
    let workflowDone = false;
    while (!historyDone || !workflowDone) {
      const historyPage: Promise<ExpiredHistoryResult[]> = historyDone
        ? Promise.resolve([])
        : this.options.history.listExpiredResults(nowIso, {
            after: historyAfter,
            limit: REFERENCE_EXPIRY_PAGE_SIZE,
          });
      const workflowPage: Promise<ExpiredWorkflowStepResult[]> = workflowDone
        ? Promise.resolve([])
        : this.options.workflowRuns.listExpiredResults(nowIso, {
            after: workflowAfter,
            limit: REFERENCE_EXPIRY_PAGE_SIZE,
          });
      const [historyExpired, workflowExpired] = await Promise.all([historyPage, workflowPage]);
      historyDone = historyExpired.length < REFERENCE_EXPIRY_PAGE_SIZE;
      workflowDone = workflowExpired.length < REFERENCE_EXPIRY_PAGE_SIZE;
      const lastHistory = historyExpired.at(-1);
      if (lastHistory) {
        historyAfter = { resultExpiresAt: lastHistory.resultExpiresAt, id: lastHistory.id };
      }
      const lastWorkflow = workflowExpired.at(-1);
      if (lastWorkflow) {
        workflowAfter = { resultExpiresAt: lastWorkflow.resultExpiresAt, id: lastWorkflow.id };
      }
      const keys = [
        ...new Set([
          ...historyExpired.map((item) => item.resultObjectKey),
          ...workflowExpired.map((item) => item.resultObjectKey),
        ]),
      ];
      if (keys.length > 0) await this.deleteBatch(keys, [], nowMs, nowIso);
    }
  }

  private async runDeletionOutbox(): Promise<void> {
    const nowMs = this.options.now?.() ?? Date.now();
    const nowIso = new Date(nowMs).toISOString();
    if (!this.options.resultStore.enabled) {
      // 元の object store へ接続できない構成では完了扱いにせず、再有効化まで job を保つ。
      const pending = await this.options.deletions.claimDue(nowIso, 1);
      if (pending.length > 0 && !this.disabledWarningLogged) {
        this.disabledWarningLogged = true;
        const message =
          'result deletion outbox is pending while ResultStore is disabled; re-enable the original ResultStore to resume deletion';
        if (this.options.logWarn) this.options.logWarn(message);
        else console.warn(message);
      }
      return;
    }
    this.disabledWarningLogged = false;
    while (true) {
      const deletionJobs = await this.options.deletions.claimDue(nowIso, DELETION_CLAIM_LIMIT);
      if (deletionJobs.length === 0) return;
      const deletableJobs: ResultObjectDeletionJob[] = [];
      const referencedKeys: string[] = [];
      for (const job of deletionJobs) {
        if (await this.options.deletions.isReferenced(job.key)) referencedKeys.push(job.key);
        else deletableJobs.push(job);
      }
      // DB link が存在する key は live object なので、誤登録された job だけを破棄する。
      await this.options.deletions.complete(referencedKeys);
      if (deletableJobs.length > 0) {
        await this.deleteBatch(
          deletableJobs.map((job) => job.key),
          deletableJobs,
          nowMs,
          nowIso,
        );
      }
      if (deletionJobs.length < DELETION_CLAIM_LIMIT) return;
    }
  }

  private async deleteBatch(
    keys: string[],
    deletionJobs: ResultObjectDeletionJob[],
    nowMs: number,
    nowIso: string,
  ): Promise<void> {
    const result = await this.options.resultStore.deleteExpired(keys.map((key) => ({ key })));
    await this.options.history.clearResultObjects(result.deleted);
    await this.options.workflowRuns.clearResultObjects(result.deleted);
    await this.options.deletions.complete(result.deleted);
    const deleted = new Set(result.deleted);
    const failures = new Map(result.failed.map((failure) => [failure.key, failure.error] as const));
    for (const job of deletionJobs) {
      if (deleted.has(job.key)) continue;
      const error = failures.get(job.key) ?? new Error('ResultStore returned no deletion outcome');
      await this.scheduleRetry(job, error, nowMs, nowIso);
    }
    for (const failed of result.failed) {
      this.options.logWarn?.(`failed to delete expired result ${failed.key}`, failed.error);
    }
  }

  private async scheduleRetry(
    job: ResultObjectDeletionJob,
    error: unknown,
    nowMs: number,
    nowIso: string,
  ): Promise<void> {
    const attempts = job.attempts + 1;
    const delay = Math.min(
      DELETION_RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 30),
      DAY_MS,
    );
    await this.options.deletions.markRetry(
      job.key,
      attempts,
      new Date(nowMs + delay).toISOString(),
      error instanceof Error ? error.message : String(error),
      nowIso,
    );
  }
}

/**
 * 期限切れクエリ結果オブジェクトの削除を行うサービス。
 */
import type { HistoryRepository } from '../store/history';
import type { WorkflowRunRepository } from '../store/workflows';
import type { ResultStore } from './store';
import { PeriodicRunner } from '../util/periodicRunner';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ResultExpiryService の生成オプション。 */
export interface ResultExpiryServiceOptions {
  history: HistoryRepository;
  workflowRuns: WorkflowRunRepository;
  resultStore: ResultStore;
  now?: () => number;
  logWarn?: (message: string, err?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

/** 起動時と日次で期限切れ result を消すサービス。 */
export class ResultExpiryService {
  private readonly periodic: PeriodicRunner;

  constructor(private readonly options: ResultExpiryServiceOptions) {
    this.periodic = new PeriodicRunner({
      intervalMs: DAY_MS,
      task: () => this.runOnce(),
      logError: (message, error) => {
        if (this.options.logWarn) this.options.logWarn(message, error);
        else console.warn(message, error);
      },
      errorMessage: 'result expiry: periodic cleanup failed',
      runImmediately: true,
      ...(options.setTimer ? { setTimer: options.setTimer } : {}),
    });
  }

  /** 起動時掃除を投げ、日次タイマーを開始する。 */
  start(): void {
    this.periodic.start();
  }

  /** タイマーを停止する。 */
  /** timer を停止し、進行中の掃除を待つ。 */
  async stop(): Promise<void> {
    await this.periodic.stop();
  }

  /** 期限切れオブジェクトを削除し、DB の key を NULL 化する。 */
  async runOnce(): Promise<void> {
    if (!this.options.resultStore.enabled) return;
    const nowIso = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const historyExpired = await this.options.history.listExpiredResults(nowIso);
    const workflowExpired = await this.options.workflowRuns.listExpiredResults(nowIso);
    const expired = [
      ...historyExpired.map((item) => ({ key: item.resultObjectKey })),
      ...workflowExpired.map((item) => ({ key: item.resultObjectKey })),
    ];
    if (expired.length === 0) return;
    const result = await this.options.resultStore.deleteExpired(expired);
    await this.options.history.clearResultObjects(result.deleted);
    await this.options.workflowRuns.clearResultObjects(result.deleted);
    for (const failed of result.failed) {
      this.options.logWarn?.(`failed to delete expired result ${failed.key}`, failed.error);
    }
  }
}

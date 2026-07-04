/**
 * 期限切れクエリ結果オブジェクトの削除を行うサービス。
 */
import type { HistoryRepository } from '../store/history';
import type { ResultStore } from './store';

const DAY_MS = 24 * 60 * 60 * 1000;

/** ResultExpiryService の生成オプション。 */
export interface ResultExpiryServiceOptions {
  history: HistoryRepository;
  resultStore: ResultStore;
  now?: () => number;
  logWarn?: (message: string, err?: unknown) => void;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

/** 起動時と日次で期限切れ result を消すサービス。 */
export class ResultExpiryService {
  private timer?: { clear: () => void };

  constructor(private readonly options: ResultExpiryServiceOptions) {}

  /** 起動時掃除を投げ、日次タイマーを開始する。 */
  start(): void {
    void this.runOnce();
    const setTimer = this.options.setTimer ?? defaultSetTimer;
    this.timer = setTimer(() => void this.runOnce(), DAY_MS);
  }

  /** タイマーを停止する。 */
  stop(): void {
    this.timer?.clear();
    this.timer = undefined;
  }

  /** 期限切れオブジェクトを削除し、DB の key を NULL 化する。 */
  async runOnce(): Promise<void> {
    if (!this.options.resultStore.enabled) return;
    const nowIso = new Date(this.options.now?.() ?? Date.now()).toISOString();
    const expired = await this.options.history.listExpiredResults(nowIso);
    if (expired.length === 0) return;
    const result = await this.options.resultStore.deleteExpired(
      expired.map((item) => ({ key: item.resultObjectKey })),
    );
    await this.options.history.clearResultObjects(result.deleted);
    for (const failed of result.failed) {
      this.options.logWarn?.(`failed to delete expired result ${failed.key}`, failed.error);
    }
  }
}

function defaultSetTimer(fn: () => void, ms: number): { clear: () => void } {
  const timer = setInterval(fn, ms);
  timer.unref?.();
  return { clear: () => clearInterval(timer) };
}

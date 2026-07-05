/**
 * GitHub 定時同期スケジューラ。
 *
 * GITHUB_SYNC_CRON に従い syncAll を実行する。workflow/runner.ts と同様に
 * nextRunAfter と setTimer 注入で次回発火を予約する。
 */
import { nextRunAfter } from '../schedule/cron';
import type { GithubSyncService } from './syncService';

export interface GithubSyncSchedulerDeps {
  syncService: GithubSyncService;
  /** null のとき定時同期は無効。 */
  syncCron: string | null;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

function defaultSetTimer(fn: () => void, ms: number): { clear: () => void } {
  const handle = setTimeout(fn, ms);
  if (typeof handle === 'object' && 'unref' in handle) (handle as { unref: () => void }).unref();
  return { clear: () => clearTimeout(handle) };
}

/** GitHub main からの定時取り込みを cron で実行する。 */
export class GithubSyncScheduler {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => { clear: () => void };
  private timer?: { clear: () => void };
  private started = false;
  private stopping = false;
  private running = false;
  private runningPromise?: Promise<void>;

  constructor(private readonly deps: GithubSyncSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? defaultSetTimer;
  }

  /** syncCron が null でなければ次回発火を予約する。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.deps.syncCron) return;
    this.scheduleNext();
  }

  /** タイマーを解除し、実行中の syncAll が終わるまで待つ。 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.clear();
    this.timer = undefined;
    if (this.runningPromise) {
      await this.runningPromise;
    }
  }

  private scheduleNext(): void {
    if (this.stopping || !this.deps.syncCron) return;
    const cron = this.deps.syncCron;
    const nowMs = this.now();
    const next = nextRunAfter(cron, new Date(nowMs));
    if (next === null) return;
    const delay = Math.max(0, next - nowMs);
    this.timer?.clear();
    this.timer = this.setTimer(() => {
      void this.runSync().finally(() => this.scheduleNext());
    }, delay);
  }

  private async runSync(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.runningPromise = this.deps.syncService
      .syncAll()
      .then(() => undefined)
      .catch((err: unknown) => {
        console.warn('github sync: scheduled syncAll failed', err);
      })
      .finally(() => {
        this.running = false;
        this.runningPromise = undefined;
      });
    await this.runningPromise;
  }
}

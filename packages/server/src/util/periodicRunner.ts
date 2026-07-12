/** 定期処理の timer、重複抑止、例外隔離、停止待機を一か所で管理する。 */

/** clear 可能な単発 timer。 */
export interface PeriodicTimerHandle {
  clear(): void;
}

/** テストで差し替え可能な timer factory。 */
export type PeriodicTimerFactory = (fn: () => void, ms: number) => PeriodicTimerHandle;

/** PeriodicRunner の生成オプション。 */
export interface PeriodicRunnerOptions {
  intervalMs: number;
  task: () => Promise<void>;
  logError: (message: string, error: unknown) => void;
  errorMessage: string;
  setTimer?: PeriodicTimerFactory;
  runImmediately?: boolean;
}

function defaultSetTimer(fn: () => void, ms: number): PeriodicTimerHandle {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { clear: () => clearTimeout(handle) };
}

/**
 * 単発 timer を毎回予約し直す定期 runner。
 * task の失敗はログへ隔離し、停止されていなければ次回実行を必ず予約する。
 */
export class PeriodicRunner {
  private readonly setTimer: PeriodicTimerFactory;
  private timer?: PeriodicTimerHandle;
  private running?: Promise<void>;
  private timerCycle?: Promise<void>;
  private started = false;
  private stopping = false;

  constructor(private readonly options: PeriodicRunnerOptions) {
    this.setTimer = options.setTimer ?? defaultSetTimer;
  }

  /** timer loop を一度だけ開始する。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.options.runImmediately) {
      this.launchTimerCycle();
      return;
    }
    this.schedule();
  }

  /** 重複呼び出し時は進行中の同じ task を待つ。 */
  runNow(): Promise<void> {
    if (this.running) return this.running;
    const running = Promise.resolve()
      .then(() => this.options.task())
      .finally(() => {
        if (this.running === running) this.running = undefined;
      });
    this.running = running;
    return running;
  }

  /** 新規予約を止め、進行中の timer cycle と task を待つ。 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.clear();
    this.timer = undefined;
    const pending = new Set<Promise<void>>();
    if (this.timerCycle) pending.add(this.timerCycle);
    if (this.running) pending.add(this.running);
    await Promise.allSettled(pending);
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = this.setTimer(() => this.launchTimerCycle(), this.options.intervalMs);
  }

  private launchTimerCycle(): void {
    if (this.stopping || this.timerCycle) return;
    this.timer = undefined;
    const cycle = this.runNow()
      .catch((error: unknown) => {
        this.options.logError(this.options.errorMessage, error);
      })
      .finally(() => {
        if (this.timerCycle === cycle) this.timerCycle = undefined;
        this.schedule();
      });
    this.timerCycle = cycle;
  }
}

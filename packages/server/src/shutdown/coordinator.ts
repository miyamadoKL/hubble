/** HTTP 受付停止から所有資源の解放までを一つの期限で制御する。 */

/** shutdown の実行段階。 */
export type ShutdownPhase =
  | 'begin-http-close'
  | 'stop-admission'
  | 'drain'
  | 'http-close'
  | 'force-http-close'
  | 'close-resources';

/** 一つの実行段階で発生したエラー。 */
export interface ShutdownPhaseError {
  phase: ShutdownPhase;
  error: unknown;
}

/** shutdown の実行結果。 */
export interface ShutdownResult {
  timedOut: boolean;
  errors: ShutdownPhaseError[];
}

/** drain が共有する絶対期限と中断通知。 */
export interface ShutdownDrainContext {
  deadlineAt: number;
  signal: AbortSignal;
}

/** テストで差し替え可能な shutdown timer。 */
export interface ShutdownTimerHandle {
  clear(): void;
}

/** テストで差し替え可能な shutdown timer factory。 */
export type ShutdownTimerFactory = (callback: () => void, delayMs: number) => ShutdownTimerHandle;

/** ShutdownCoordinator が順番を制御する処理。 */
export interface ShutdownCoordinatorOptions {
  timeoutMs: number;
  beginHttpClose: () => void | Promise<void>;
  stopAdmission: () => void;
  drain: (context: ShutdownDrainContext) => Promise<void>;
  forceCloseHttp: () => void;
  closeResources: () => void | Promise<void>;
  now?: () => number;
  setTimer?: ShutdownTimerFactory;
}

type WaitOutcome =
  | { status: 'fulfilled' }
  | { status: 'rejected'; error: unknown }
  | { status: 'timed-out' };

type DeadlinePhase = 'drain' | 'http-close' | 'close-resources';

function defaultSetTimer(callback: () => void, delayMs: number): ShutdownTimerHandle {
  const timer = setTimeout(callback, delayMs);
  return { clear: () => clearTimeout(timer) };
}

function observe(task: Promise<void>): Promise<WaitOutcome> {
  return task.then(
    (): WaitOutcome => ({ status: 'fulfilled' }),
    (error: unknown): WaitOutcome => ({ status: 'rejected', error }),
  );
}

/** shutdown の絶対期限を超えたことを示す。 */
export class ShutdownTimeoutError extends Error {
  constructor(
    readonly phase: DeadlinePhase,
    readonly deadlineAt: number,
  ) {
    super(`Shutdown ${phase} exceeded deadline ${deadlineAt}`);
    this.name = 'ShutdownTimeoutError';
  }
}

/**
 * 新規受付停止、drain、HTTP close、所有資源解放をこの順番で一度だけ実行する。
 * 各段階の失敗は結果へ集約し、後続段階の実行を妨げない。
 */
export class ShutdownCoordinator {
  private readonly now: () => number;
  private readonly setTimer: ShutdownTimerFactory;
  private inFlight?: Promise<ShutdownResult>;

  constructor(private readonly options: ShutdownCoordinatorOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) {
      throw new Error('shutdown timeoutMs must be a non-negative finite number');
    }
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? defaultSetTimer;
  }

  /** 重複呼び出しでは最初の shutdown と同じ Promise を返す。 */
  shutdown(): Promise<ShutdownResult> {
    if (this.inFlight) return this.inFlight;

    let resolveResult!: (result: ShutdownResult) => void;
    this.inFlight = new Promise<ShutdownResult>((resolve) => {
      resolveResult = resolve;
    });

    const errors: ShutdownPhaseError[] = [];
    const deadlineAt = this.now() + this.options.timeoutMs;
    let httpClose: Promise<WaitOutcome> | undefined;

    try {
      httpClose = observe(Promise.resolve(this.options.beginHttpClose()));
    } catch (error: unknown) {
      errors.push({ phase: 'begin-http-close', error });
    }

    try {
      this.options.stopAdmission();
    } catch (error: unknown) {
      errors.push({ phase: 'stop-admission', error });
    }

    void this.finishShutdown(deadlineAt, httpClose, errors).then(resolveResult);
    return this.inFlight;
  }

  private async finishShutdown(
    deadlineAt: number,
    httpClose: Promise<WaitOutcome> | undefined,
    errors: ShutdownPhaseError[],
  ): Promise<ShutdownResult> {
    const abortController = new AbortController();
    let timedOut = false;
    let forced = false;

    const forceHttpClose = (): void => {
      if (forced) return;
      forced = true;
      try {
        this.options.forceCloseHttp();
      } catch (error: unknown) {
        errors.push({ phase: 'force-http-close', error });
      }
    };

    const recordOutcome = (phase: DeadlinePhase, outcome: WaitOutcome): void => {
      if (outcome.status === 'rejected') {
        errors.push({ phase, error: outcome.error });
        return;
      }
      if (outcome.status === 'timed-out') {
        timedOut = true;
        errors.push({ phase, error: new ShutdownTimeoutError(phase, deadlineAt) });
        abortController.abort();
        forceHttpClose();
      }
    };

    try {
      let drain: Promise<WaitOutcome>;
      try {
        drain = observe(
          Promise.resolve(this.options.drain({ deadlineAt, signal: abortController.signal })),
        );
      } catch (error: unknown) {
        drain = Promise.resolve({ status: 'rejected', error });
      }
      recordOutcome('drain', await this.waitUntil(drain, deadlineAt));

      if (httpClose) {
        recordOutcome('http-close', await this.waitUntil(httpClose, deadlineAt));
      }
    } finally {
      try {
        const closeResources = this.options.closeResources();
        if (closeResources) {
          recordOutcome(
            'close-resources',
            await this.waitUntil(observe(closeResources), deadlineAt),
          );
        }
      } catch (error: unknown) {
        errors.push({ phase: 'close-resources', error });
      }
    }

    return { timedOut, errors };
  }

  private waitUntil(task: Promise<WaitOutcome>, deadlineAt: number): Promise<WaitOutcome> {
    const remainingMs = deadlineAt - this.now();
    if (remainingMs <= 0) {
      return Promise.race([task, Promise.resolve({ status: 'timed-out' } as const)]);
    }

    return new Promise<WaitOutcome>((resolve) => {
      let finished = false;
      const finish = (outcome: WaitOutcome): void => {
        if (finished) return;
        finished = true;
        timer.clear();
        resolve(outcome);
      };
      const timer = this.setTimer(() => finish({ status: 'timed-out' }), remainingMs);
      void task.then(finish);
    });
  }
}

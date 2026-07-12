/**
 * schedule、workflow、alert が共有するジョブ実行枠。
 *
 * `tryAcquire` は await を挟まず同一ターン内で重複判定と全体上限判定を行う。
 * 取得した lease の解放は冪等であり、成功、失敗、起動前例外の全経路から安全に呼べる。
 */

export type JobKind = 'schedule' | 'workflow' | 'alert';

export type JobAdmissionRejection = 'duplicate' | 'capacity' | 'closed';

/** ジョブ実行枠を取得できなかったことを表す。 */
export class JobAdmissionRejectedError extends Error {
  constructor(
    readonly reason: JobAdmissionRejection,
    readonly jobKind: JobKind,
    readonly jobId: string,
  ) {
    const detail =
      reason === 'duplicate'
        ? 'has a run in progress'
        : reason === 'capacity'
          ? 'exceeds the concurrency limit'
          : 'cannot start while the server is shutting down';
    super(`${jobKind} ${jobId} ${detail}`);
    this.name = 'JobAdmissionRejectedError';
  }
}

/** 取得済み実行枠。`release` は複数回呼んでも一度だけ解放する。 */
export interface JobAdmissionLease {
  /** job claim を保持したまま、予約済み statement 実行枠だけを返す。 */
  releaseCapacity(): void;
  release(): void;
}

/** Workflow の各 statement が一時的に保持する実行枠。 */
export interface JobCapacityLease {
  release(): void;
}

interface CapacityWaiter {
  active: boolean;
  signal?: AbortSignal;
  abort: () => void;
  resolve: (lease: JobCapacityLease) => void;
  reject: (error: Error) => void;
}

/** 1プロセス内の全ジョブ種別で共有する admission controller。 */
export class JobAdmissionController {
  private readonly active = new Set<string>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly capacityWaiters: CapacityWaiter[] = [];
  private capacityInUse = 0;
  private accepting = true;

  constructor(private readonly maxConcurrent: number) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('Job admission maxConcurrent must be a positive integer');
    }
  }

  /** 重複と全体上限を原子的に判定し、実行枠を取得する。 */
  tryAcquire(jobKind: JobKind, jobId: string): JobAdmissionLease {
    const key = `${jobKind}\u0000${jobId}`;
    if (!this.accepting) {
      throw new JobAdmissionRejectedError('closed', jobKind, jobId);
    }
    if (this.active.has(key)) {
      throw new JobAdmissionRejectedError('duplicate', jobKind, jobId);
    }
    if (this.capacityInUse >= this.maxConcurrent) {
      throw new JobAdmissionRejectedError('capacity', jobKind, jobId);
    }

    this.active.add(key);
    this.capacityInUse += 1;
    let released = false;
    let capacityHeld = true;
    const releaseCapacity = (): void => {
      if (!capacityHeld) return;
      capacityHeld = false;
      this.releasePermit();
    };
    return {
      releaseCapacity,
      release: () => {
        if (released) return;
        released = true;
        this.active.delete(key);
        releaseCapacity();
        this.notifyIdle();
      },
    };
  }

  /** admission 済み Workflow の statement 実行枠を FIFO で取得する。 */
  acquireCapacity(signal?: AbortSignal): Promise<JobCapacityLease> {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.capacityInUse < this.maxConcurrent) {
      this.capacityInUse += 1;
      return Promise.resolve(this.capacityLease());
    }

    return new Promise((resolve, reject) => {
      const waiter: CapacityWaiter = {
        active: true,
        signal,
        abort: () => {
          if (!waiter.active) return;
          waiter.active = false;
          const index = this.capacityWaiters.indexOf(waiter);
          if (index >= 0) this.capacityWaiters.splice(index, 1);
          reject(abortError());
          this.notifyIdle();
        },
        resolve,
        reject,
      };
      this.capacityWaiters.push(waiter);
      signal?.addEventListener('abort', waiter.abort, { once: true });
      if (signal?.aborted) waiter.abort();
    });
  }

  /** 現在取得されている全ジョブ種別合計の実行枠数。 */
  get activeCount(): number {
    return this.active.size;
  }

  /** statement 実行用に現在消費している共有枠数。 */
  get activeCapacityCount(): number {
    return this.capacityInUse;
  }

  /** 新しい手動実行とcron発火の受付を同期的に止める。 */
  stopAccepting(): void {
    this.accepting = false;
  }

  /** 取得済みleaseがすべて解放されるまで待つ。 */
  whenIdle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private capacityLease(): JobCapacityLease {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.releasePermit();
      },
    };
  }

  private releasePermit(): void {
    if (this.capacityInUse > 0) this.capacityInUse -= 1;
    for (;;) {
      const waiter = this.capacityWaiters.shift();
      if (!waiter) break;
      if (!waiter.active) continue;
      waiter.active = false;
      waiter.signal?.removeEventListener('abort', waiter.abort);
      this.capacityInUse += 1;
      waiter.resolve(this.capacityLease());
      break;
    }
    this.notifyIdle();
  }

  private isIdle(): boolean {
    return this.active.size === 0 && this.capacityInUse === 0 && this.capacityWaiters.length === 0;
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}

function abortError(): Error {
  const error = new Error('Job capacity acquisition aborted');
  error.name = 'AbortError';
  return error;
}

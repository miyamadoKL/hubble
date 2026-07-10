/**
 * Alert通知outboxを周期的に配送するworker。
 */
import type { AlertChannelNotificationSender } from '../notification/service';
import type { AlertDeliveryJob, AlertDeliveryRepository } from '../store/alertDeliveries';

const CLAIM_LIMIT = 50;

export interface AlertDeliveryWorkerConfig {
  intervalMs: number;
  maxAttempts: number;
  backoffMs: number;
}

export interface AlertDeliveryWorkerDeps {
  deliveries: AlertDeliveryRepository;
  notifications: AlertChannelNotificationSender;
  config: AlertDeliveryWorkerConfig;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
  logWarn?: (message: string, detail?: unknown) => void;
}

function defaultSetTimer(fn: () => void, ms: number): { clear: () => void } {
  const handle = setTimeout(fn, ms);
  handle.unref?.();
  return { clear: () => clearTimeout(handle) };
}

/** 単一プロセス内でAlert通知配送を直列実行する。 */
export class AlertDeliveryWorker {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => { clear: () => void };
  private readonly logWarn: (message: string, detail?: unknown) => void;
  private timer?: { clear: () => void };
  private running?: Promise<void>;
  private started = false;
  private stopping = false;

  constructor(private readonly deps: AlertDeliveryWorkerDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
    this.logWarn = deps.logWarn ?? ((message, detail) => console.warn(message, detail));
  }

  /** workerの周期実行を開始する。 */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.schedule();
  }

  /** 新規tickを止め、実行中の配送完了を待つ。 */
  async stop(): Promise<void> {
    this.stopping = true;
    this.timer?.clear();
    this.timer = undefined;
    await this.running;
  }

  /** dueジョブを1回処理する。重複tickは同じPromiseを待つ。 */
  async tick(): Promise<void> {
    if (this.running) return this.running;
    const running = this.runTick().finally(() => {
      if (this.running === running) this.running = undefined;
    });
    this.running = running;
    return running;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = this.setTimer(() => {
      void this.tick().finally(() => this.schedule());
    }, this.deps.config.intervalMs);
  }

  private async runTick(): Promise<void> {
    const jobs = await this.deps.deliveries.claimDue(
      new Date(this.now()).toISOString(),
      CLAIM_LIMIT,
    );
    // claimは単一プロセスの直列tickを前提とする。複数instanceでは分散lockとleaseが必要。
    for (const job of jobs) await this.deliver(job);
  }

  private async deliver(job: AlertDeliveryJob): Promise<void> {
    try {
      await this.deps.notifications.sendChannel(job.channel, job.payload);
      await this.deps.deliveries.markSent(job.id, new Date(this.now()).toISOString());
    } catch (err) {
      const attempts = job.attempts + 1;
      const message = err instanceof Error ? err.message : String(err);
      const nowMs = this.now();
      const nowIso = new Date(nowMs).toISOString();
      if (attempts >= this.deps.config.maxAttempts) {
        await this.deps.deliveries.markDead(job.id, attempts, message, nowIso);
        this.logWarn(`alert delivery moved to dead: delivery_id=${job.id}`, err);
        return;
      }
      const delay = Math.min(
        this.deps.config.backoffMs * 2 ** Math.min(Math.max(attempts - 1, 0), 30),
        2_147_483_647,
      );
      await this.deps.deliveries.markRetry(
        job.id,
        attempts,
        new Date(nowMs + delay).toISOString(),
        message,
        nowIso,
      );
    }
  }
}

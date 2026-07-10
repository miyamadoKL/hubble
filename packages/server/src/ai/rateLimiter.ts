const RATE_WINDOW_MS = 60_000;

export interface AiRateLimiterOptions {
  maxConcurrency: number;
  perPrincipalPerMinute: number;
  now?: () => number;
}

export type AiRateLimitResult =
  | { ok: true; release: () => void }
  | { ok: false; retryAfterSeconds: number };

/** 単一プロセス内で AI 要求の並行数と principal 別頻度を制御する。 */
export class AiRateLimiter {
  private readonly maxConcurrency: number;
  private readonly perPrincipalPerMinute: number;
  private readonly now: () => number;
  private readonly requestTimes = new Map<string, number[]>();
  private inFlight = 0;

  constructor(options: AiRateLimiterOptions) {
    this.maxConcurrency = options.maxConcurrency;
    this.perPrincipalPerMinute = options.perPrincipalPerMinute;
    this.now = options.now ?? Date.now;
  }

  /** 上限内なら利用枠を取得し、冪等な解放関数を返す。 */
  tryAcquire(principal: string): AiRateLimitResult {
    const now = this.now();
    const cutoff = now - RATE_WINDOW_MS;
    const activeTimes = (this.requestTimes.get(principal) ?? []).filter(
      (requestedAt) => requestedAt > cutoff,
    );

    if (activeTimes.length >= this.perPrincipalPerMinute) {
      this.requestTimes.set(principal, activeTimes);
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((activeTimes[0]! + RATE_WINDOW_MS - now) / 1_000)),
      };
    }
    if (this.inFlight >= this.maxConcurrency) {
      return { ok: false, retryAfterSeconds: 1 };
    }

    activeTimes.push(now);
    this.requestTimes.set(principal, activeTimes);
    this.inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight -= 1;
      },
    };
  }
}

// マルチインスタンス構成では、同じ制限を共有ストア上で原子的に管理する必要がある。

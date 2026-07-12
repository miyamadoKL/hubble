import { describe, expect, it } from 'vitest';
import { AiRateLimiter } from './rateLimiter';

describe('AiRateLimiter', () => {
  it('rejects a principal within the window and permits it after one minute', () => {
    let now = 1_000;
    const limiter = new AiRateLimiter({
      maxConcurrency: 2,
      perPrincipalPerMinute: 1,
      now: () => now,
    });

    const first = limiter.tryAcquire('alice');
    expect(first.ok).toBe(true);
    if (first.ok) first.release();

    expect(limiter.tryAcquire('alice')).toEqual({ ok: false, retryAfterSeconds: 60 });
    now += 60_001;
    expect(limiter.tryAcquire('alice').ok).toBe(true);
  });

  it('rejects at the global concurrency limit and permits after idempotent release', () => {
    const limiter = new AiRateLimiter({ maxConcurrency: 1, perPrincipalPerMinute: 10 });
    const first = limiter.tryAcquire('alice');
    expect(first.ok).toBe(true);
    expect(limiter.tryAcquire('bob')).toEqual({ ok: false, retryAfterSeconds: 1 });

    if (first.ok) {
      first.release();
      first.release();
    }
    expect(limiter.tryAcquire('bob').ok).toBe(true);
  });

  it('期限切れ principal を周期 sweep で Map から削除する', () => {
    let now = 1_000;
    const limiter = new AiRateLimiter({
      maxConcurrency: 10,
      perPrincipalPerMinute: 10,
      now: () => now,
    });
    for (const principal of ['alice', 'bob', 'carol']) {
      const result = limiter.tryAcquire(principal);
      if (result.ok) result.release();
    }
    const trackedPrincipals = () =>
      (
        limiter as unknown as {
          requestTimes: Map<string, number[]>;
        }
      ).requestTimes;
    expect(trackedPrincipals().size).toBe(3);

    now += 60_001;
    const next = limiter.tryAcquire('dave');
    if (next.ok) next.release();

    expect([...trackedPrincipals().keys()]).toEqual(['dave']);
  });

  it('sweep後も有効な履歴とRetry-Afterを維持する', () => {
    let now = 1_000;
    const limiter = new AiRateLimiter({
      maxConcurrency: 10,
      perPrincipalPerMinute: 1,
      now: () => now,
    });
    const alice = limiter.tryAcquire('alice');
    if (alice.ok) alice.release();
    now = 31_000;
    const bob = limiter.tryAcquire('bob');
    if (bob.ok) bob.release();

    now = 61_001;
    const carol = limiter.tryAcquire('carol');
    if (carol.ok) carol.release();

    expect(limiter.tryAcquire('bob')).toEqual({ ok: false, retryAfterSeconds: 30 });
  });
});

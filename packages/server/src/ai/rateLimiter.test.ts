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
});

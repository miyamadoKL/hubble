import { describe, expect, it } from 'vitest';
import { isValidCron, nextRunAfter, nextRunIso } from './cron';

describe('cron helpers', () => {
  it('validates 5-field cron expressions', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('0,30 * * * *')).toBe(true);
  });

  it('rejects garbage expressions', () => {
    expect(isValidCron('not a cron')).toBe(false);
    expect(isValidCron('99 * * * *')).toBe(false);
    expect(isValidCron('')).toBe(false);
  });

  it('computes the next fire strictly after the reference time', () => {
    // 2026-01-01T00:00:30Z, every minute -> next is 00:01:00Z.
    const from = new Date('2026-01-01T00:00:30.000Z');
    const next = nextRunAfter('* * * * *', from);
    expect(next).not.toBeNull();
    expect(new Date(next!).toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });

  it('is computed from "now", so missed fires are skipped (no backfill)', () => {
    // Resuming far after a daily 00:00 schedule yields the *next* future 00:00,
    // never a backfilled past one.
    const resumeAt = new Date('2026-03-10T08:15:00.000Z');
    const next = nextRunIso('0 0 * * *', resumeAt);
    expect(next).not.toBeNull();
    expect(new Date(next!).getTime()).toBeGreaterThan(resumeAt.getTime());
  });

  it('returns null for an invalid expression', () => {
    expect(nextRunAfter('bogus', new Date())).toBeNull();
    expect(nextRunIso('bogus', new Date())).toBeNull();
  });
});

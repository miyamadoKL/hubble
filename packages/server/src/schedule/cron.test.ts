import { describe, expect, it } from 'vitest';
import { isValidCron, nextRunAfter, nextRunIso } from './cron';

/**
 * cron.ts (isValidCron / nextRunAfter / nextRunIso) のテスト。
 * 日本語: 5 フィールド cron 式の妥当性判定と、「now を基準にバックフィルしない」という
 * 次回発火時刻計算の設計方針が正しく実装されているかを検証する。
 */
describe('cron helpers', () => {
  // 妥当な 5 フィールド cron 式 (毎分/5分毎/曜日指定/カンマ区切り等) が true になること。
  it('validates 5-field cron expressions', () => {
    expect(isValidCron('* * * * *')).toBe(true);
    expect(isValidCron('*/5 * * * *')).toBe(true);
    expect(isValidCron('0 9 * * 1-5')).toBe(true);
    expect(isValidCron('0,30 * * * *')).toBe(true);
  });

  // 不正な文字列、範囲外の値、空文字が false になること (空文字は cron-parser の
  // 「毎分」扱いを明示的に拒否する isValidCron 独自のガード)。
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

  // 日本語: 過去の毎日 00:00 発火を長期間取りこぼした後でも、過去分を遡って
  // 返す (バックフィルする) のではなく、必ず基準時刻より未来の発火のみを返すことを確認する。
  it('is computed from "now", so missed fires are skipped (no backfill)', () => {
    // Resuming far after a daily 00:00 schedule yields the *next* future 00:00,
    // never a backfilled past one.
    const resumeAt = new Date('2026-03-10T08:15:00.000Z');
    const next = nextRunIso('0 0 * * *', resumeAt);
    expect(next).not.toBeNull();
    expect(new Date(next!).getTime()).toBeGreaterThan(resumeAt.getTime());
  });

  // 不正な cron 式に対しては例外を投げず null を返す (呼び出し側での分岐を単純にするため)。
  it('returns null for an invalid expression', () => {
    expect(nextRunAfter('bogus', new Date())).toBeNull();
    expect(nextRunIso('bogus', new Date())).toBeNull();
  });
});

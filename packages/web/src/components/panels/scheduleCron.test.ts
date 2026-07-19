import { describe, expect, test } from 'vitest';
import {
  builderStateToCron,
  cronToBuilderState,
  describeCronState,
  describeCronStateWithTimeZone,
  isCronStateValid,
  DEFAULT_CRON_STATE,
  type ScheduleCronState,
} from './scheduleCron';

function state(over: Partial<ScheduleCronState> = {}): ScheduleCronState {
  return { ...DEFAULT_CRON_STATE, ...over };
}

describe('builderStateToCron', () => {
  test('hourly: minute のみ指定し他はワイルドカード', () => {
    expect(builderStateToCron(state({ mode: 'hourly', minute: 15 }))).toBe('15 * * * *');
  });

  test('daily: 分と時を指定', () => {
    expect(builderStateToCron(state({ mode: 'daily', minute: 30, hour: 9 }))).toBe('30 9 * * *');
  });

  test('weekly: 曜日を昇順に並べ、重複を除いたリストにする', () => {
    expect(
      builderStateToCron(state({ mode: 'weekly', minute: 0, hour: 9, weekdays: [3, 1, 1, 5] })),
    ).toBe('0 9 * * 1,3,5');
  });

  test('weekly: 曜日が空なら dow はワイルドカード', () => {
    expect(builderStateToCron(state({ mode: 'weekly', weekdays: [] }))).toBe(
      `${DEFAULT_CRON_STATE.minute} ${DEFAULT_CRON_STATE.hour} * * *`,
    );
  });

  test('monthly: 日を指定', () => {
    expect(builderStateToCron(state({ mode: 'monthly', minute: 0, hour: 3, dayOfMonth: 1 }))).toBe(
      '0 3 1 * *',
    );
  });

  test('custom: 入力をそのまま返す', () => {
    expect(builderStateToCron(state({ mode: 'custom', custom: '*/5 * * * *' }))).toBe(
      '*/5 * * * *',
    );
  });
});

describe('cronToBuilderState (保守的な逆変換)', () => {
  test('hourly パターンを認識する', () => {
    const result = cronToBuilderState('15 * * * *');
    expect(result.mode).toBe('hourly');
    expect(result.minute).toBe(15);
  });

  test('daily パターンを認識する', () => {
    const result = cronToBuilderState('30 9 * * *');
    expect(result.mode).toBe('daily');
    expect(result.minute).toBe(30);
    expect(result.hour).toBe(9);
  });

  test('weekly パターン（複数曜日）を認識する', () => {
    const result = cronToBuilderState('0 9 * * 1,3,5');
    expect(result.mode).toBe('weekly');
    expect(result.weekdays).toEqual([1, 3, 5]);
    expect(result.hour).toBe(9);
    expect(result.minute).toBe(0);
  });

  test('weekly パターン（単一曜日）を認識する', () => {
    const result = cronToBuilderState('0 9 * * 1');
    expect(result.mode).toBe('weekly');
    expect(result.weekdays).toEqual([1]);
  });

  test('monthly パターンを認識する', () => {
    const result = cronToBuilderState('0 3 1 * *');
    expect(result.mode).toBe('monthly');
    expect(result.dayOfMonth).toBe(1);
  });

  test('往復変換で同じ cron 式に戻る（プリセットが認識できる場合）', () => {
    for (const cron of ['15 * * * *', '30 9 * * *', '0 9 * * 1,3,5', '0 3 1 * *']) {
      const round = builderStateToCron(cronToBuilderState(cron));
      expect(round).toBe(cron);
    }
  });

  // --- 逆変換不能なケース（保守的に custom へフォールバックする境界） ---

  test('曜日リストが降順/重複だと custom にフォールバックする', () => {
    expect(cronToBuilderState('0 9 * * 3,1').mode).toBe('custom');
    expect(cronToBuilderState('0 9 * * 1,1,3').mode).toBe('custom');
  });

  test('ステップ値や範囲は custom にフォールバックする', () => {
    expect(cronToBuilderState('*/5 * * * *').mode).toBe('custom');
    expect(cronToBuilderState('0 8 * * 1-5').mode).toBe('custom');
  });

  test('month フィールドがワイルドカード以外なら custom にフォールバックする', () => {
    expect(cronToBuilderState('0 9 1 6 *').mode).toBe('custom');
  });

  test('5 フィールドでない文字列は custom にフォールバックする', () => {
    const result = cronToBuilderState('not a cron');
    expect(result.mode).toBe('custom');
    expect(result.custom).toBe('not a cron');
  });

  test('曜日フィールドが範囲外の数字なら custom にフォールバックする', () => {
    expect(cronToBuilderState('0 9 * * 7').mode).toBe('custom');
  });
});

describe('isCronStateValid', () => {
  test('weekly は曜日が 1 つ以上必要', () => {
    expect(isCronStateValid(state({ mode: 'weekly', weekdays: [] }))).toBe(false);
    expect(isCronStateValid(state({ mode: 'weekly', weekdays: [1] }))).toBe(true);
  });

  test('custom は契約の cron 式スキーマに従う', () => {
    expect(isCronStateValid(state({ mode: 'custom', custom: '* * * * *' }))).toBe(true);
    expect(isCronStateValid(state({ mode: 'custom', custom: 'not a cron' }))).toBe(false);
  });

  test('hourly/daily/monthly は常に有効', () => {
    expect(isCronStateValid(state({ mode: 'hourly' }))).toBe(true);
    expect(isCronStateValid(state({ mode: 'daily' }))).toBe(true);
    expect(isCronStateValid(state({ mode: 'monthly' }))).toBe(true);
  });
});

describe('describeCronState (日本語読み下し)', () => {
  test('hourly', () => {
    expect(describeCronState(state({ mode: 'hourly', minute: 5 }))).toBe('毎時 5 分に実行');
  });

  test('daily', () => {
    expect(describeCronState(state({ mode: 'daily', hour: 9, minute: 0 }))).toBe(
      '毎日 09:00 に実行',
    );
  });

  test('weekly: 曜日 1 件は「の」でつなぐ', () => {
    expect(describeCronState(state({ mode: 'weekly', weekdays: [1], hour: 9, minute: 30 }))).toBe(
      '毎週 月の 09:30 に実行',
    );
  });

  test('weekly: 曜日 2 件は「と」でつなぐ（中黒は使わない）', () => {
    const text = describeCronState(
      state({ mode: 'weekly', weekdays: [1, 3], hour: 9, minute: 30 }),
    );
    expect(text).toBe('毎週 月と水の 09:30 に実行');
    expect(text).not.toContain('・');
  });

  test('weekly: 曜日 3 件以上は読点でつなぐ（「と」は使わない）', () => {
    const text = describeCronState(
      state({ mode: 'weekly', weekdays: [1, 3, 5], hour: 9, minute: 0 }),
    );
    expect(text).toBe('毎週 月、水、金の 09:00 に実行');
    expect(text).not.toContain('と');
  });

  test('weekly: 曜日が空なら未選択メッセージ', () => {
    expect(describeCronState(state({ mode: 'weekly', weekdays: [] }))).toBe(
      '曜日が選択されていません',
    );
  });

  test('monthly', () => {
    expect(describeCronState(state({ mode: 'monthly', dayOfMonth: 15, hour: 3, minute: 0 }))).toBe(
      '毎月 15 日の 03:00 に実行',
    );
  });

  test('custom', () => {
    expect(describeCronState(state({ mode: 'custom', custom: '*/5 * * * *' }))).toBe(
      'カスタム cron 式で実行: */5 * * * *',
    );
  });
});

describe('describeCronStateWithTimeZone (指摘3: 読み下しにタイムゾーンを明記する)', () => {
  test('タイムゾーンが取得済みなら IANA 名を明記する', () => {
    const text = describeCronStateWithTimeZone(
      state({ mode: 'daily', hour: 9, minute: 0 }),
      'Asia/Tokyo',
    );
    expect(text).toBe('毎日 09:00 に実行（サーバー時刻: Asia/Tokyo）');
  });

  test('タイムゾーン未取得（null）の間は「サーバー時刻基準」とだけ表示する', () => {
    const text = describeCronStateWithTimeZone(state({ mode: 'daily', hour: 9, minute: 0 }), null);
    expect(text).toBe('毎日 09:00 に実行（サーバー時刻基準）');
    expect(text).not.toContain('Asia');
  });
});

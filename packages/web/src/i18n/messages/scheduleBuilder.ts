/**
 * Schedule / Alert 共通のスケジュールビルダー（`ScheduleBuilder.tsx` と、その変換
 * ロジックを担う `scheduleCron.ts`）で使う文言の辞書。cron 生入力を隠す非エンジニア
 * 向け UI（毎時/毎日/毎週/毎月/カスタムのプリセット選択）のラベルと、現在の設定を
 * 読み下す文の両方をここに集約する。
 */
import { defineDictionary } from '../t';

export const scheduleBuilderMessages = defineDictionary({
  // モード選択チップの行全体（radiogroup）の accessible name。ScheduleFormModal /
  // AlertFormModal どちらの呼び出し元にも「Schedule」という視覚ラベルがあるが、
  // ScheduleBuilder はそれを id 参照できない独立コンポーネントなので、単独の
  // accessible name として辞書化する（可視ラベルとの重複ではないため削除しない）。
  scheduleFrequencyAria: { ja: 'スケジュールの頻度', en: 'Schedule frequency' },

  // プリセットモードの選択チップ。
  modeHourly: { ja: '毎時', en: 'Hourly' },
  modeDaily: { ja: '毎日', en: 'Daily' },
  modeWeekly: { ja: '毎週', en: 'Weekly' },
  modeMonthly: { ja: '毎月', en: 'Monthly' },
  modeCustom: { ja: 'カスタム', en: 'Custom' },

  // 各モードの入力欄ラベル。
  minuteHourlyLabel: {
    ja: '分（毎時この分に実行）',
    en: 'Minute (runs at this minute every hour)',
  },
  weekdayLabel: { ja: '曜日（複数選択可）', en: 'Weekday (select multiple)' },
  selectAtLeastOneWeekday: {
    ja: '曜日を 1 つ以上選択してください。',
    en: 'Select at least one weekday.',
  },
  dayOfMonthLabel: { ja: '日（1-31）', en: 'Day of month (1-31)' },
  hourLabel: { ja: '時（0-23）', en: 'Hour (0-23)' },
  minuteLabel: { ja: '分（0-59）', en: 'Minute (0-59)' },
  cronExpressionLabel: {
    ja: '実行タイミング（分 時 日 月 曜日 の 5 項目）',
    en: 'Timing (5 fields: minute hour day month weekday)',
  },
  cronExpressionPlaceholder: {
    ja: '分 時 日 月 曜日',
    en: 'minute hour day-of-month month day-of-week',
  },

  // 曜日ラベル（週の先頭を日曜とする）。
  weekdaySun: { ja: '日', en: 'Sun' },
  weekdayMon: { ja: '月', en: 'Mon' },
  weekdayTue: { ja: '火', en: 'Tue' },
  weekdayWed: { ja: '水', en: 'Wed' },
  weekdayThu: { ja: '木', en: 'Thu' },
  weekdayFri: { ja: '金', en: 'Fri' },
  weekdaySat: { ja: '土', en: 'Sat' },

  // 現在の設定の読み下し文（describeCronState）。
  describeHourly: { ja: '毎時 {minute} 分に実行', en: 'Every hour at minute {minute}' },
  describeDaily: { ja: '毎日 {time} に実行', en: 'Daily at {time}' },
  describeWeekly: { ja: '毎週 {days}の {time} に実行', en: 'Every week on {days} at {time}' },
  describeWeeklyEmpty: { ja: '曜日が選択されていません', en: 'No weekday selected' },
  describeMonthly: { ja: '毎月 {day} 日の {time} に実行', en: 'Monthly on day {day} at {time}' },
  describeCustom: { ja: 'カスタム設定で実行: {cron}', en: 'Custom timing: {cron}' },
  describeCustomEmpty: { ja: '(未入力)', en: '(empty)' },

  // 曜日リストの列挙。2 項は「と」/"and"、3 項以上は読点/カンマで並べる
  // （japanese-tech-writing 規範: 日本語の並列で中黒は使わない）。
  weekdayJoinTwo: { ja: '{a}と{b}', en: '{a} and {b}' },

  // cron を評価する基準タイムゾーンの付記。
  timeZoneWithName: { ja: '（サーバー時刻: {tz}）', en: ' (server time: {tz})' },
  timeZoneUnknown: { ja: '（サーバー時刻基準）', en: ' (server time basis)' },
} as const);

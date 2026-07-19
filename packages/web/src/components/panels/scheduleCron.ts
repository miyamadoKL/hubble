import { cronExpression } from '@hubble/contracts';
import { t } from '../../i18n/t';
import { scheduleBuilderMessages } from '../../i18n/messages/scheduleBuilder';
import type { Locale } from '../../i18n/locale';

/**
 * Schedule / Alert 共通のスケジュールビルダー（ScheduleBuilder.tsx）が使う、
 * UI を持たない純粋関数集。cron 生入力を非エンジニアにも扱えるようにするため、
 * 「毎時 / 毎日 / 毎週 / 毎月 / カスタム (cron)」という 5 つのプリセットモードと
 * 契約層の 5 フィールド cron 式（分 時 日 月 曜日）とを相互変換する。
 *
 * 変換の方向は 2 つ:
 *   1. `builderStateToCron`: プリセットモードの入力値 → cron 式文字列（常にこちらを
 *      契約の `cron` フィールドへ格納する。契約スキーマ自体は変更しない）。
 *   2. `cronToBuilderState`: 既存の cron 式 → プリセットモード（編集時の初期表示用）。
 *      上記のプリセット範囲に確実に一致する場合のみプリセット化し、少しでも
 *      あいまいな場合（ステップ値、範囲、複数の分/時候補など）は `custom` モードに
 *      倒す（「逆変換は保守的に」という要件）。
 *
 * `describeCronState` は現在の設定を日本語の読み下し文にする（モーダル常時表示用）。
 */

/** ビルダーが提供するプリセットモード。custom は現行の cron 直接入力を維持する。 */
export type ScheduleCronMode = 'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom';

/**
 * ビルダーの入力状態。モードに応じて使うフィールドが変わる
 * （例: hourly は minute のみ、weekly は weekdays + hour/minute）。
 * 契約層には送らない中間表現であり、`builderStateToCron` で 5 フィールド cron へ変換する。
 */
export interface ScheduleCronState {
  mode: ScheduleCronMode;
  /** 0-59。hourly/daily/weekly/monthly で使う「分」。 */
  minute: number;
  /** 0-23。daily/weekly/monthly で使う「時」。 */
  hour: number;
  /** 0(日)-6(土) の集合。weekly で使う曜日（複数選択可、UI 上は昇順で保持）。 */
  weekdays: number[];
  /** 1-31。monthly で使う「日」。 */
  dayOfMonth: number;
  /** custom モードで使う cron 式の生文字列。 */
  custom: string;
}

/**
 * 曜日ラベル（cron の 0=日曜始まり）をロケール別に返す。
 * `describeCronState` の読み下しと `ScheduleBuilder.tsx` の曜日選択ボタンの両方で使う。
 */
export function weekdayLabels(locale: Locale): readonly string[] {
  return [
    t(scheduleBuilderMessages, 'weekdaySun', locale),
    t(scheduleBuilderMessages, 'weekdayMon', locale),
    t(scheduleBuilderMessages, 'weekdayTue', locale),
    t(scheduleBuilderMessages, 'weekdayWed', locale),
    t(scheduleBuilderMessages, 'weekdayThu', locale),
    t(scheduleBuilderMessages, 'weekdayFri', locale),
    t(scheduleBuilderMessages, 'weekdaySat', locale),
  ];
}

/** 新規作成フォームの既定値（毎日 9:00）。 */
export const DEFAULT_CRON_STATE: ScheduleCronState = {
  mode: 'daily',
  minute: 0,
  hour: 9,
  weekdays: [1],
  dayOfMonth: 1,
  custom: '0 9 * * *',
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 2 桁ゼロ埋めの "HH:MM" 表記に整形する。 */
export function formatTime(hour: number, minute: number): string {
  return `${pad2(hour)}:${pad2(minute)}`;
}

/**
 * ビルダーの状態を、契約の 5 フィールド cron 式（分 時 日 月 曜日）へ変換する。
 * custom モードはユーザー入力をそのまま返す（バリデーションは呼び出し側の
 * `cronExpression` スキーマに委ねる）。
 */
export function builderStateToCron(state: ScheduleCronState): string {
  switch (state.mode) {
    case 'hourly':
      return `${state.minute} * * * *`;
    case 'daily':
      return `${state.minute} ${state.hour} * * *`;
    case 'weekly': {
      // 曜日は昇順に並べ、重複を除いてから cron のリスト形式 (例: "1,3,5") にする。
      const days = [...new Set(state.weekdays)].sort((a, b) => a - b);
      const dow = days.length > 0 ? days.join(',') : '*';
      return `${state.minute} ${state.hour} * * ${dow}`;
    }
    case 'monthly':
      return `${state.minute} ${state.hour} ${state.dayOfMonth} * *`;
    case 'custom':
    default:
      return state.custom;
  }
}

// "0" や "23" のような単一の非負整数のみを許容する（先頭ゼロは許容するが、
// 範囲/リスト/ステップ/ワイルドカードは許容しない）フィールド判定。
const SINGLE_INT = /^\d{1,2}$/;
// 曜日リスト用: "1,3,5" のように 1 桁の数字をカンマ区切りにしたものだけを許容する。
const DOW_LIST = /^\d(?:,\d)*$/;

function parseSingleInt(field: string, min: number, max: number): number | null {
  if (!SINGLE_INT.test(field)) return null;
  const n = Number(field);
  return n >= min && n <= max ? n : null;
}

/**
 * cron 式をビルダーの状態へ逆変換する。5 フィールドのうち、いずれかがプリセットの
 * 想定形（ワイルドカードまたは単一の整数/整数リスト）から外れる場合は、確実に
 * 等価とは言えないため custom モードにフォールバックする（保守的な逆変換）。
 * 変換に失敗した cron 文字列も custom モードとして安全に表示できる。
 */
export function cronToBuilderState(cron: string): ScheduleCronState {
  const fallbackCustom: ScheduleCronState = { ...DEFAULT_CRON_STATE, mode: 'custom', custom: cron };
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return fallbackCustom;
  const [minuteField, hourField, domField, monthField, dowField] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // month フィールドを使うプリセットは無いため、ワイルドカード以外は常に custom。
  if (monthField !== '*') return fallbackCustom;

  const minute = parseSingleInt(minuteField, 0, 59);

  // hourly: 分のみ指定、時/日/曜日はすべてワイルドカード。
  if (minute !== null && hourField === '*' && domField === '*' && dowField === '*') {
    return { ...DEFAULT_CRON_STATE, mode: 'hourly', minute };
  }

  const hour = parseSingleInt(hourField, 0, 23);
  if (minute === null || hour === null) return fallbackCustom;

  // daily: 分+時を指定、日/曜日はワイルドカード。
  if (domField === '*' && dowField === '*') {
    return { ...DEFAULT_CRON_STATE, mode: 'daily', minute, hour };
  }

  // monthly: 分+時+日を指定、曜日はワイルドカード。
  if (dowField === '*') {
    const dayOfMonth = parseSingleInt(domField, 1, 31);
    if (dayOfMonth !== null) {
      return { ...DEFAULT_CRON_STATE, mode: 'monthly', minute, hour, dayOfMonth };
    }
    return fallbackCustom;
  }

  // weekly: 分+時+曜日を指定、日はワイルドカード。曜日は昇順に並び重複のないリストのみ認める
  // (例: "1,3,5" は OK だが "3,1" や "1,1,3" は custom のままにする)。
  if (domField === '*' && DOW_LIST.test(dowField)) {
    const days = dowField.split(',').map(Number);
    const isSorted = days.every((d, i) => i === 0 || d > days[i - 1]!);
    const inRange = days.every((d) => d >= 0 && d <= 6);
    if (isSorted && inRange) {
      return { ...DEFAULT_CRON_STATE, mode: 'weekly', minute, hour, weekdays: days };
    }
  }

  return fallbackCustom;
}

/**
 * ビルダー状態がそのまま送信可能かどうかを判定する。weekly モードで曜日が
 * 1 つも選ばれていない場合（cron としては dow='*' と解釈でき構文的には妥当だが、
 * 「毎週」の意図に反して毎日実行になってしまう）と、custom モードで cron 式が
 * 契約スキーマの 5 フィールド形式を満たさない場合を無効とする。
 */
export function isCronStateValid(state: ScheduleCronState): boolean {
  if (state.mode === 'weekly') return state.weekdays.length > 0;
  if (state.mode === 'custom') return cronExpression.safeParse(state.custom).success;
  return true;
}

/**
 * 曜日ラベルの配列を自然な文にする。2 項は「と」/"and"、3 項以上は日本語なら読点
 * 「、」、英語ならカンマ区切り + 最後だけ "and" でつなぐ（japanese-tech-writing 規範:
 * 日本語の並列で中黒は使わない）。
 */
function joinWeekdayLabels(labels: readonly string[], locale: Locale): string {
  if (labels.length <= 1) return labels[0] ?? '';
  if (labels.length === 2) {
    return t(scheduleBuilderMessages, 'weekdayJoinTwo', locale, { a: labels[0]!, b: labels[1]! });
  }
  if (locale === 'ja') return labels.join('、');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/**
 * 現在のビルダー状態を読み下し文にする（モーダル内に常時表示する説明文）。
 * `locale` 省略時は 'ja'（既存呼び出し元との後方互換用のデフォルト値。UI から呼ぶ場合は
 * `useLocale()` で得た現在のロケールを明示的に渡す）。
 */
export function describeCronState(state: ScheduleCronState, locale: Locale = 'ja'): string {
  switch (state.mode) {
    case 'hourly':
      return t(scheduleBuilderMessages, 'describeHourly', locale, { minute: state.minute });
    case 'daily':
      return t(scheduleBuilderMessages, 'describeDaily', locale, {
        time: formatTime(state.hour, state.minute),
      });
    case 'weekly': {
      const days = [...new Set(state.weekdays)].sort((a, b) => a - b);
      if (days.length === 0) return t(scheduleBuilderMessages, 'describeWeeklyEmpty', locale);
      const allLabels = weekdayLabels(locale);
      const labels = days.map((d) => allLabels[d]!);
      return t(scheduleBuilderMessages, 'describeWeekly', locale, {
        days: joinWeekdayLabels(labels, locale),
        time: formatTime(state.hour, state.minute),
      });
    }
    case 'monthly':
      return t(scheduleBuilderMessages, 'describeMonthly', locale, {
        day: state.dayOfMonth,
        time: formatTime(state.hour, state.minute),
      });
    case 'custom':
    default:
      // custom モードは直下の入力欄に生の cron 式が見えているため、読み下し文には
      // 式を埋め込まない（UI/UX から cron 式表示を極力排除する方針）。
      return t(scheduleBuilderMessages, 'describeCustom', locale);
  }
}

/**
 * `describeCronState` の読み下しに、cron 式を評価する基準タイムゾーンを付記する。
 * server の scheduler（`packages/server/src/schedule/cron.ts`）は server local
 * timezone で cron 式を評価するため、表示側の読み下しにこの基準を明記しないと
 * 「表示時刻」と「実際に実行される時刻」が一致する保証がない。
 * `timeZone` は `GET /api/config` の `serverTimeZone`（IANA 名、例: "Asia/Tokyo"）を
 * 渡す。web がまだ取得できていない間は null を渡すと「サーバー時刻基準」とだけ表示する。
 */
export function describeCronStateWithTimeZone(
  state: ScheduleCronState,
  timeZone: string | null,
  locale: Locale = 'ja',
): string {
  const suffix = timeZone
    ? t(scheduleBuilderMessages, 'timeZoneWithName', locale, { tz: timeZone })
    : t(scheduleBuilderMessages, 'timeZoneUnknown', locale);
  return `${describeCronState(state, locale)}${suffix}`;
}

/**
 * 一覧行（SchedulesPanel/AlertsPanel）向けの cron 読み下し。
 * サーバー時刻タイムゾーンの括弧書きは行の横幅が狭いため付けない基本形を使う
 * （タイムゾーン付きの詳細な読み下しはフォーム内の `describeCronStateWithTimeZone` に
 * 任せる）。プリセットへ逆変換できないカスタム式は、生の cron 式を一覧に出さない方針
 * （UI/UX から cron 式表示を極力排除する）のため、式を埋め込まず `customScheduleLabel`
 * のみを返す（式は編集フォームのカスタム欄でのみ確認できる）。
 */
export function describeCronForList(cron: string, locale: Locale = 'ja'): string {
  const state = cronToBuilderState(cron);
  if (state.mode === 'custom') {
    return t(scheduleBuilderMessages, 'customScheduleLabel', locale);
  }
  return describeCronState(state, locale);
}

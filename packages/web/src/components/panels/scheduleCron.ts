import { cronExpression } from '@hubble/contracts';

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

/** 曜日ラベル（cron の 0=日曜始まり）。 */
export const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const;

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
 * 現在のビルダー状態を日本語の読み下し文にする（モーダル内に常時表示する説明文）。
 * 曜日の並列は japanese-tech-writing 規範に従い、中黒ではなく
 * 2 項は「と」、3 項以上は読点「、」でつなぐ。
 */
export function describeCronState(state: ScheduleCronState): string {
  switch (state.mode) {
    case 'hourly':
      return `毎時 ${state.minute} 分に実行`;
    case 'daily':
      return `毎日 ${formatTime(state.hour, state.minute)} に実行`;
    case 'weekly': {
      const days = [...new Set(state.weekdays)].sort((a, b) => a - b);
      if (days.length === 0) return '曜日が選択されていません';
      const labels = days.map((d) => WEEKDAY_LABELS[d]);
      const joined =
        labels.length === 1
          ? labels[0]
          : labels.length === 2
            ? `${labels[0]}と${labels[1]}`
            : labels.join('、');
      return `毎週 ${joined}の ${formatTime(state.hour, state.minute)} に実行`;
    }
    case 'monthly':
      return `毎月 ${state.dayOfMonth} 日の ${formatTime(state.hour, state.minute)} に実行`;
    case 'custom':
    default:
      return `カスタム cron 式で実行: ${state.custom || '(未入力)'}`;
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
): string {
  const suffix = timeZone ? `（サーバー時刻: ${timeZone}）` : '（サーバー時刻基準）';
  return `${describeCronState(state)}${suffix}`;
}

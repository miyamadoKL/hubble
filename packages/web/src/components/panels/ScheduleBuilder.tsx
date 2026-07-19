/**
 * Schedule / Alert 共通のスケジュールビルダー（cron 生入力を隠す UX）。
 *
 * 「毎時 / 毎日 / 毎週 / 毎月 / カスタム (cron)」のモードを切り替えて、非エンジニアでも
 * cron 式を組み立てられるようにする。値は常に契約層の 5 フィールド cron 式へ変換して
 * `onChange` へ渡すため、呼び出し元（ScheduleFormModal / AlertFormModal）が保持する
 * state やリクエスト形状は変わらない（契約は変更しない）。
 * 変換ロジック本体は `scheduleCron.ts` の純関数に切り出してあり、このファイルは
 * その状態管理と入力 UI のみを担当する。
 */
import { useEffect, useState } from 'react';
import {
  builderStateToCron,
  cronToBuilderState,
  describeCronStateWithTimeZone,
  isCronStateValid,
  weekdayLabels,
  type ScheduleCronMode,
  type ScheduleCronState,
} from './scheduleCron';
import { useServerTimeZone } from '../../hooks/useConfig';
import { cn } from '../../utils/cn';
import { useLocale } from '../../i18n/locale';
import { useT } from '../../i18n/t';
import { scheduleBuilderMessages } from '../../i18n/messages/scheduleBuilder';

const FIELD_LABEL = 'text-2xs font-semibold tracking-wide text-ink-muted uppercase';
const TEXT_INPUT =
  'w-full rounded-md border border-border-base bg-surface-base px-3 py-2 text-sm text-ink-strong placeholder:text-ink-subtle focus:border-accent focus:outline-none';

// プリセットモードのラベルキー（プレースホルダーを持たない辞書エントリのみに絞った
// union）。ここを `keyof typeof scheduleBuilderMessages`（辞書全体）にすると、t() の
// 呼び出しが「プレースホルダー付きエントリを引く可能性がある」と型推論されてしまい、
// 補間引数なしの呼び出しが型エラーになる（describeXxx 系エントリの存在のため）。
type ModeLabelKey = 'modeHourly' | 'modeDaily' | 'modeWeekly' | 'modeMonthly' | 'modeCustom';

/** プリセットモードのキー一覧。表示ラベルは辞書（scheduleBuilderMessages）から引く。 */
const MODE_KEYS: { mode: ScheduleCronMode; labelKey: ModeLabelKey }[] = [
  { mode: 'hourly', labelKey: 'modeHourly' },
  { mode: 'daily', labelKey: 'modeDaily' },
  { mode: 'weekly', labelKey: 'modeWeekly' },
  { mode: 'monthly', labelKey: 'modeMonthly' },
  { mode: 'custom', labelKey: 'modeCustom' },
];

interface ScheduleBuilderProps {
  /** 現在の cron 式（初期表示のみに使う。以後の変更は内部状態が正本）。 */
  value: string;
  /** 状態が変わるたびに、変換済みの 5 フィールド cron 式を渡す。 */
  onChange: (cron: string) => void;
  /**
   * 状態が変わるたびに、送信可能かどうか (isCronStateValid) を渡す。weekly モードで
   * 曜日が 1 つも選ばれていない場合など、cron としては構文的に妥当でも意図と異なる
   * 結果になるケースを呼び出し元の canSave 判定に反映させるために使う。
   */
  onValidChange?: (valid: boolean) => void;
}

/**
 * cron 式を「毎時 / 毎日 / 毎週 / 毎月 / カスタム」のプリセット UI で編集させる共通コンポーネント。
 * 初期表示は `value`（既存 cron 式）をプリセットへ逆変換して復元し、一致しなければ
 * カスタムモードで生の cron 入力欄を表示する（保守的な逆変換は scheduleCron.ts 側の責務）。
 */
export function ScheduleBuilder({ value, onChange, onValidChange }: ScheduleBuilderProps) {
  const [state, setState] = useState<ScheduleCronState>(() => cronToBuilderState(value));
  // server の scheduler は server local timezone で cron を評価するため、読み下しに
  // その基準を明記する。未取得の間は useServerTimeZone が null を返し、
  // describeCronStateWithTimeZone が「サーバー時刻基準」とだけ表示する。
  const serverTimeZone = useServerTimeZone();
  const { locale } = useLocale();
  const t = useT(scheduleBuilderMessages);

  // 状態が変わるたびに cron 式へ変換して呼び出し元（フォーム側の cron state）へ伝える。
  useEffect(() => {
    onChange(builderStateToCron(state));
    onValidChange?.(isCronStateValid(state));
    // state の変化だけを監視する。onChange/onValidChange は呼び出し側でクロージャが
    // 変わりうるため依存に含めない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const toggleWeekday = (day: number) => {
    setState((s) => {
      const has = s.weekdays.includes(day);
      const weekdays = has ? s.weekdays.filter((d) => d !== day) : [...s.weekdays, day];
      return { ...s, weekdays };
    });
  };

  return (
    <div className="flex flex-col gap-2.5" data-testid="schedule-builder">
      {/* モード選択チップ。CRON_PRESETS と同じ見た目のトグルボタン列。
          呼び出し元（ScheduleFormModal/AlertFormModal）側に「Schedule」という可視
          ラベルがあるが、このコンポーネント単体では参照できないため、単独の
          accessible name として辞書化した aria-label を持たせる。 */}
      <div
        className="flex flex-wrap gap-1.5"
        role="radiogroup"
        aria-label={t('scheduleFrequencyAria')}
      >
        {MODE_KEYS.map((opt) => (
          <button
            key={opt.mode}
            type="button"
            role="radio"
            aria-checked={state.mode === opt.mode}
            onClick={() => setState((s) => ({ ...s, mode: opt.mode }))}
            className={cn(
              'rounded-full px-2.5 py-1 text-2xs font-medium transition-colors',
              state.mode === opt.mode
                ? 'bg-accent-soft text-accent'
                : 'bg-surface-sunken text-ink-muted hover:text-ink-strong',
            )}
          >
            {t(opt.labelKey)}
          </button>
        ))}
      </div>

      {/* モードごとの入力欄。可視の <span> と重複する aria-label は持たせず、
          label 要素の implicit association に委ねる（レビュー指摘）。 */}
      {state.mode === 'hourly' && (
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>{t('minuteHourlyLabel')}</span>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            max={59}
            value={state.minute}
            name="minute"
            onChange={(e) =>
              setState((s) => ({ ...s, minute: clamp(Number(e.target.value), 0, 59) }))
            }
            className={cn(TEXT_INPUT, 'font-mono')}
          />
        </label>
      )}

      {state.mode === 'daily' && <TimeFields state={state} setState={setState} />}

      {state.mode === 'weekly' && (
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>{t('weekdayLabel')}</span>
            <div className="flex flex-wrap gap-1.5">
              {weekdayLabels(locale).map((label, day) => (
                <button
                  key={day}
                  type="button"
                  aria-pressed={state.weekdays.includes(day)}
                  onClick={() => toggleWeekday(day)}
                  className={cn(
                    'h-8 w-8 rounded-full text-xs font-medium transition-colors',
                    state.weekdays.includes(day)
                      ? 'bg-accent-soft text-accent'
                      : 'bg-surface-sunken text-ink-muted hover:text-ink-strong',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
            {state.weekdays.length === 0 && (
              <p role="alert" className="font-mono text-2xs text-error">
                {t('selectAtLeastOneWeekday')}
              </p>
            )}
          </div>
          <TimeFields state={state} setState={setState} />
        </div>
      )}

      {state.mode === 'monthly' && (
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5">
            <span className={FIELD_LABEL}>{t('dayOfMonthLabel')}</span>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              value={state.dayOfMonth}
              name="dayOfMonth"
              onChange={(e) =>
                setState((s) => ({ ...s, dayOfMonth: clamp(Number(e.target.value), 1, 31) }))
              }
              className={cn(TEXT_INPUT, 'font-mono')}
            />
          </label>
          <TimeInputs state={state} setState={setState} />
        </div>
      )}

      {state.mode === 'custom' && (
        <label className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>{t('cronExpressionLabel')}</span>
          <input
            value={state.custom}
            name="cron"
            spellCheck={false}
            onChange={(e) => setState((s) => ({ ...s, custom: e.target.value }))}
            placeholder={t('cronExpressionPlaceholder')}
            className={cn(TEXT_INPUT, 'font-mono')}
          />
        </label>
      )}

      {/* 現在の設定の読み下し。常時表示してユーザーが設定内容を確認できるようにする。
          cron を評価する基準タイムゾーン（server local timezone）も常に明記する。 */}
      <p className="font-mono text-2xs text-ink-subtle">
        {describeCronStateWithTimeZone(state, serverTimeZone, locale)}
      </p>
    </div>
  );
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** 「日」欄を伴わない、時刻のみのラベル付きフィールド（daily/weekly で共用）。 */
function TimeFields({
  state,
  setState,
}: {
  state: ScheduleCronState;
  setState: (updater: (s: ScheduleCronState) => ScheduleCronState) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <TimeInputs state={state} setState={setState} />
    </div>
  );
}

/** 時/分の数値入力 2 つ（grid の親は呼び出し側が用意する）。 */
function TimeInputs({
  state,
  setState,
}: {
  state: ScheduleCronState;
  setState: (updater: (s: ScheduleCronState) => ScheduleCronState) => void;
}) {
  const t = useT(scheduleBuilderMessages);
  return (
    <>
      <label className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL}>{t('hourLabel')}</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={23}
          value={state.hour}
          name="hour"
          onChange={(e) => setState((s) => ({ ...s, hour: clamp(Number(e.target.value), 0, 23) }))}
          className={cn(TEXT_INPUT, 'font-mono')}
        />
      </label>
      <label className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL}>{t('minuteLabel')}</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={59}
          value={state.minute}
          name="minute"
          onChange={(e) =>
            setState((s) => ({ ...s, minute: clamp(Number(e.target.value), 0, 59) }))
          }
          className={cn(TEXT_INPUT, 'font-mono')}
        />
      </label>
    </>
  );
}

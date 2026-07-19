/**
 * TopBar に置く日英ロケール切替トグル。
 * 現在のロケールを 2 文字（"JA" / "EN"）で常時表示し、クリックでもう一方に切り替える。
 * テーマ切替 IconButton と同様、aria-label には「切替先」を説明する文言を使う
 * （現在の状態ではなく、押すとどうなるかを伝える既存の規約に合わせる）。
 * 表示文字列は常に 2 文字に固定しているため、切替によってボタン幅が変わらず、
 * TopBar のレイアウトに影響しない。
 */
import { useLocale } from '../../i18n/locale';
import { useT } from '../../i18n/t';
import { commonMessages } from '../../i18n/messages/common';
import { Tooltip } from '../common/Tooltip';
import { cn } from '../../utils/cn';

/** TopBar の右寄せグループに置くロケール切替トグル。 */
export function LocaleToggle() {
  const { locale, setLocale } = useLocale();
  const t = useT(commonMessages);
  const next = locale === 'ja' ? 'en' : 'ja';
  const label = next === 'ja' ? t('switchToJapanese') : t('switchToEnglish');

  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        data-testid="locale-toggle"
        onClick={() => setLocale(next)}
        className={cn(
          'inline-flex h-8 w-8 items-center justify-center rounded-md border font-mono text-2xs font-semibold',
          'border-border-base bg-surface-raised text-ink-muted transition-colors duration-100',
          'hover:bg-surface-sunken hover:text-ink-strong',
          'focus-visible:outline-2 focus-visible:outline-offset-2',
        )}
      >
        {locale === 'ja' ? 'JA' : 'EN'}
      </button>
    </Tooltip>
  );
}

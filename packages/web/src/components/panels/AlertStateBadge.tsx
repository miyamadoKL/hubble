/**
 * Alert の実行時状態（AlertState）を共通バッジで表示する。契約値
 * （ok/triggered/unknown）自体は変更せず、表示ラベルだけをロケールに応じて翻訳する。
 */
import type { AlertState } from '@hubble/contracts';
import { StatusBadge, type StatusBadgeTone } from '../common/StatusBadge';
import { useLocale } from '../../i18n/locale';
import { alertStateLabel } from './alertFormat';

const stateTone: Record<AlertState, StatusBadgeTone> = {
  ok: 'success',
  triggered: 'error',
  unknown: 'neutral',
};

/** Alert の状態バッジ。 */
export function AlertStateBadge({ state, className }: { state: AlertState; className?: string }) {
  const { locale } = useLocale();
  return (
    <StatusBadge
      tone={stateTone[state]}
      label={alertStateLabel(state, locale)}
      className={className}
    />
  );
}

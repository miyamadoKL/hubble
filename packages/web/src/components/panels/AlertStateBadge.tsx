/** Alertの状態を共通バッジで表示する。 */
import type { AlertState } from '@hubble/contracts';
import { StatusBadge, type StatusBadgeTone } from '../common/StatusBadge';

const stateTone: Record<AlertState, StatusBadgeTone> = {
  ok: 'success',
  triggered: 'error',
  unknown: 'neutral',
};

const stateLabels: Record<AlertState, string> = {
  ok: 'OK',
  triggered: 'Triggered',
  unknown: 'Unknown',
};

/** Alertの状態バッジ。 */
export function AlertStateBadge({ state, className }: { state: AlertState; className?: string }) {
  return <StatusBadge tone={stateTone[state]} label={stateLabels[state]} className={className} />;
}

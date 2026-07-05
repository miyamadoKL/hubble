/**
 * Alert の状態遷移と通知判定の純粋関数。
 * Redash の next_state / should_notify 相当のロジックを担う。
 */
import type { AlertOp, AlertSelector, AlertState } from '@hubble/contracts';

/** 閾値比較の入力。 */
export interface ThresholdCompareInput {
  observed: unknown;
  op: AlertOp;
  threshold: string;
}

/**
 * 監視値が閾値条件を満たすか判定する。
 * 閾値と監視値の双方が数値にパースできれば数値比較、それ以外は文字列比較（== と != のみ）。
 */
export function compareThreshold(input: ThresholdCompareInput): boolean {
  const { observed, op, threshold } = input;
  const numObs = parseNumeric(observed);
  const numThr = parseNumeric(threshold);
  if (numObs !== null && numThr !== null) {
    return numericCompare(numObs, numThr, op);
  }
  const strObs = stringifyValue(observed);
  if (op === '==') return strObs === threshold;
  if (op === '!=') return strObs !== threshold;
  return false;
}

/**
 * 結果行から selector に従い監視値を取り出す。
 * @param rows - クエリ結果行（列インデックス順の配列）。
 * @param columnIndex - 監視対象カラムのインデックス。
 * @param selector - first / max / min。
 */
export function selectObservedValue(
  rows: readonly (readonly unknown[])[],
  columnIndex: number,
  selector: AlertSelector,
): unknown {
  if (rows.length === 0) return undefined;
  const values = rows.map((row) => row[columnIndex]);
  if (selector === 'first') return values[0];
  const nums = values.map(parseNumeric);
  if (nums.every((n) => n !== null)) {
    const numbers = nums as number[];
    return selector === 'max' ? Math.max(...numbers) : Math.min(...numbers);
  }
  const strings = values.map(stringifyValue);
  const sorted = [...strings].sort((a, b) => a.localeCompare(b));
  return selector === 'max' ? sorted[sorted.length - 1] : sorted[0];
}

/**
 * 条件の真偽から次の Alert state を決定する。
 * unknown → triggered/ok、ok ↔ triggered の遷移のみ。
 */
export function nextAlertState(_currentState: AlertState, conditionMet: boolean): AlertState {
  if (conditionMet) return 'triggered';
  return 'ok';
}

export interface ShouldNotifyInput {
  previousState: AlertState;
  newState: AlertState;
  rearm: number;
  lastTriggeredAt: string | null;
  nowMs: number;
  muted: boolean;
}

/**
 * 今回の評価で通知を送るべきか判定する。
 * unknown → ok では通知しない。triggered 状態の維持時は rearm に従う。
 */
export function shouldNotify(input: ShouldNotifyInput): boolean {
  if (input.muted) return false;
  if (input.newState !== 'triggered') return false;
  if (input.previousState === 'unknown' && input.newState === 'triggered') return true;
  if (input.previousState !== 'triggered' && input.newState === 'triggered') return true;
  // triggered → triggered
  if (input.rearm === 0) return false;
  if (input.rearm === 1) return true;
  if (!input.lastTriggeredAt) return true;
  const elapsedMs = input.nowMs - new Date(input.lastTriggeredAt).getTime();
  return elapsedMs >= input.rearm * 1000;
}

function parseNumeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') return Number(value);
  const str = stringifyValue(value);
  if (str === '') return null;
  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function numericCompare(observed: number, threshold: number, op: AlertOp): boolean {
  switch (op) {
    case '>':
      return observed > threshold;
    case '>=':
      return observed >= threshold;
    case '<':
      return observed < threshold;
    case '<=':
      return observed <= threshold;
    case '==':
      return observed === threshold;
    case '!=':
      return observed !== threshold;
  }
}

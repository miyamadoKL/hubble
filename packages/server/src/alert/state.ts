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
  /** 監視対象カラムのエンジン型。数値型の変換失敗を評価エラーとして扱うために使う。 */
  columnType?: string;
}

/** 数値型の監視値または閾値を正確に比較できないことを表す。 */
export class AlertNumericConversionError extends Error {
  readonly code = 'INVALID_NUMERIC_VALUE';

  constructor(label: 'observed value' | 'threshold', value: unknown, columnType?: string) {
    const rendered = stringifyValue(value);
    const typeSuffix = columnType ? ` for ${columnType}` : '';
    super(`Invalid numeric ${label}${typeSuffix}: ${rendered}`);
    this.name = 'AlertNumericConversionError';
  }
}

interface ExactDecimal {
  sign: -1 | 0 | 1;
  digits: string;
  exponent: bigint;
}

/**
 * 監視値が閾値条件を満たすか判定する。
 * 閾値と監視値の双方が数値にパースできれば数値比較、それ以外は文字列比較（== と != のみ）。
 */
export function compareThreshold(input: ThresholdCompareInput): boolean {
  const { observed, op, threshold, columnType } = input;
  if (isApproximateNumericType(columnType)) {
    const numObs = parseApproximateNumeric(observed);
    const numThr = parseApproximateNumeric(threshold);
    if (numObs === null)
      throw new AlertNumericConversionError('observed value', observed, columnType);
    if (numThr === null) throw new AlertNumericConversionError('threshold', threshold, columnType);
    return compareOrdering(numObs === numThr ? 0 : numObs < numThr ? -1 : 1, op);
  }

  const exactObs = parseExactDecimal(observed);
  const exactThr = parseExactDecimal(threshold);
  if (exactObs !== null && exactThr !== null) {
    return compareOrdering(compareExactDecimals(exactObs, exactThr), op);
  }
  if (isExactNumericType(columnType)) {
    if (exactObs === null) {
      throw new AlertNumericConversionError('observed value', observed, columnType);
    }
    throw new AlertNumericConversionError('threshold', threshold, columnType);
  }
  if (isUnsafeIntegerNumber(observed)) {
    throw new AlertNumericConversionError('observed value', observed, columnType);
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
  columnType?: string,
): unknown {
  if (rows.length === 0) return undefined;
  const values = rows.map((row) => row[columnIndex]);
  if (selector === 'first') return values[0];

  if (isApproximateNumericType(columnType)) {
    const numbers = values.map(parseApproximateNumeric);
    const invalidIndex = numbers.findIndex((value) => value === null);
    if (invalidIndex >= 0) {
      throw new AlertNumericConversionError('observed value', values[invalidIndex], columnType);
    }
    return selectByComparison(values, numbers as number[], selector, (left, right) =>
      left === right ? 0 : left < right ? -1 : 1,
    );
  }

  const exactValues = values.map(parseExactDecimal);
  if (exactValues.every((value) => value !== null)) {
    return selectByComparison(
      values,
      exactValues as ExactDecimal[],
      selector,
      compareExactDecimals,
    );
  }
  if (isExactNumericType(columnType)) {
    const invalidIndex = exactValues.findIndex((value) => value === null);
    throw new AlertNumericConversionError('observed value', values[invalidIndex], columnType);
  }
  const unsafeIndex = values.findIndex(isUnsafeIntegerNumber);
  if (unsafeIndex >= 0) {
    throw new AlertNumericConversionError('observed value', values[unsafeIndex], columnType);
  }
  const strings = values.map(stringifyValue);
  return selectByComparison(values, strings, selector, (left, right) => left.localeCompare(right));
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

function parseApproximateNumeric(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
  }
  const str = stringifyValue(value);
  if (str === '') return null;
  const n = Number(str);
  return Number.isFinite(n) ? n : null;
}

function parseExactDecimal(value: unknown): ExactDecimal | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    if (isUnsafeIntegerNumber(value)) return null;
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    return null;
  }
  const text = String(value).trim();
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) return null;

  const fraction = match[3] ?? match[4] ?? '';
  let digits = `${match[2] ?? ''}${fraction}`.replace(/^0+/, '');
  if (digits === '') return { sign: 0, digits: '0', exponent: 0n };
  const trailingZeroCount = digits.length - digits.replace(/0+$/, '').length;
  if (trailingZeroCount > 0) digits = digits.slice(0, -trailingZeroCount);
  const exponent = BigInt(match[5] ?? '0') - BigInt(fraction.length) + BigInt(trailingZeroCount);
  return {
    sign: match[1] === '-' ? -1 : 1,
    digits,
    exponent,
  };
}

function isUnsafeIntegerNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value);
}

function compareExactDecimals(left: ExactDecimal, right: ExactDecimal): number {
  if (left.sign !== right.sign) return left.sign < right.sign ? -1 : 1;
  if (left.sign === 0) return 0;

  const leftMagnitude = BigInt(left.digits.length) + left.exponent;
  const rightMagnitude = BigInt(right.digits.length) + right.exponent;
  let absoluteComparison: number;
  if (leftMagnitude !== rightMagnitude) {
    absoluteComparison = leftMagnitude < rightMagnitude ? -1 : 1;
  } else {
    const width = Math.max(left.digits.length, right.digits.length);
    const normalizedLeft = left.digits.padEnd(width, '0');
    const normalizedRight = right.digits.padEnd(width, '0');
    absoluteComparison =
      normalizedLeft === normalizedRight ? 0 : normalizedLeft < normalizedRight ? -1 : 1;
  }
  return left.sign === 1 ? absoluteComparison : -absoluteComparison;
}

function isExactNumericType(columnType: string | undefined): boolean {
  if (!columnType) return false;
  return /^(?:tinyint|smallint|integer|int|bigint|decimal|numeric|dec|fixed|newdecimal|tiny|short|long|longlong|int24)(?:\b|\()/i.test(
    columnType,
  );
}

function isApproximateNumericType(columnType: string | undefined): boolean {
  if (!columnType) return false;
  return /^(?:real|double|float)(?:\b|\()/i.test(columnType);
}

function selectByComparison<T>(
  originalValues: unknown[],
  comparableValues: T[],
  selector: Exclude<AlertSelector, 'first'>,
  compare: (left: T, right: T) => number,
): unknown {
  let selectedIndex = 0;
  for (let index = 1; index < comparableValues.length; index += 1) {
    const ordering = compare(comparableValues[index]!, comparableValues[selectedIndex]!);
    if ((selector === 'max' && ordering > 0) || (selector === 'min' && ordering < 0)) {
      selectedIndex = index;
    }
  }
  return originalValues[selectedIndex];
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function compareOrdering(ordering: number, op: AlertOp): boolean {
  switch (op) {
    case '>':
      return ordering > 0;
    case '>=':
      return ordering >= 0;
    case '<':
      return ordering < 0;
    case '<=':
      return ordering <= 0;
    case '==':
      return ordering === 0;
    case '!=':
      return ordering !== 0;
  }
}

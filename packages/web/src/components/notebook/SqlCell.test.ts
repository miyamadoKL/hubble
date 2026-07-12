// 複文セルの変数解決をbatch開始前に全件確定することを検証する。
import { describe, expect, test, vi } from 'vitest';
import type { ExecutionUnit } from '../../execution';
import { resolveAllExecutionUnits } from './SqlCell';

function unit(text: string, start: number): ExecutionUnit {
  return { text, start, end: start + text.length };
}

describe('resolveAllExecutionUnits', () => {
  test('先頭unitの解決失敗時に後続INSERTを残した部分batchを作らない', () => {
    const select = unit('SELECT ${missing}', 0);
    const insert = unit('INSERT INTO audit_log VALUES (1)', select.end + 1);
    const resolve = vi.fn((candidate: ExecutionUnit) => (candidate === select ? null : candidate));

    expect(resolveAllExecutionUnits([select, insert], resolve)).toBeNull();
  });

  test('全unitを解決できた場合だけ順序を保った配列を返す', () => {
    const select = unit('SELECT 1', 0);
    const insert = unit('INSERT INTO audit_log VALUES (1)', select.end + 1);

    expect(resolveAllExecutionUnits([select, insert], (candidate) => candidate)).toEqual([
      select,
      insert,
    ]);
  });
});

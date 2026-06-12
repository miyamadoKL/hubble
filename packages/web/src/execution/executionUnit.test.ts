import { describe, expect, test } from 'vitest';
import { allUnits, resolveExecution, statementAtOffset } from './executionUnit';

const SOURCE = 'SELECT 1;\nSELECT 2;\nSELECT 3';
//              0123456789  (line1)  ...

describe('allUnits', () => {
  test('returns every statement in order with offset spans', () => {
    const units = allUnits(SOURCE);
    expect(units.map((u) => u.text)).toEqual(['SELECT 1', 'SELECT 2', 'SELECT 3']);
    // First unit spans the literal "SELECT 1".
    expect(SOURCE.slice(units[0]!.start, units[0]!.end)).toBe('SELECT 1');
    expect(SOURCE.slice(units[2]!.start, units[2]!.end)).toBe('SELECT 3');
  });

  test('empty source → no units', () => {
    expect(allUnits('   \n  ')).toEqual([]);
  });
});

describe('statementAtOffset', () => {
  test('caret inside the first statement returns it', () => {
    expect(statementAtOffset(SOURCE, 3)?.text).toBe('SELECT 1');
  });

  test('caret inside the second statement returns it', () => {
    // offset 13 lands inside "SELECT 2" on line 2.
    expect(statementAtOffset(SOURCE, 13)?.text).toBe('SELECT 2');
  });

  test('caret at end of source returns the last statement', () => {
    expect(statementAtOffset(SOURCE, SOURCE.length)?.text).toBe('SELECT 3');
  });

  test('caret on a blank separator line falls back to the preceding statement', () => {
    const src = 'SELECT 1;\n\nSELECT 2';
    // offset 10 is the empty line after the first `;`.
    expect(statementAtOffset(src, 10)?.text).toBe('SELECT 1');
  });
});

describe('resolveExecution', () => {
  test('no selection → the statement under the caret (single unit)', () => {
    const units = resolveExecution(SOURCE, { anchor: 3, active: 3 });
    expect(units).toHaveLength(1);
    expect(units[0]!.text).toBe('SELECT 1');
  });

  test('a non-empty selection → exactly the selected text (one unit)', () => {
    // Select "SELECT 2" on line 2 (offsets 10..18).
    const units = resolveExecution(SOURCE, { anchor: 10, active: 18 });
    expect(units).toHaveLength(1);
    expect(units[0]!.text).toBe('SELECT 2');
    // Span re-anchors onto the real characters.
    expect(SOURCE.slice(units[0]!.start, units[0]!.end)).toBe('SELECT 2');
  });

  test('a backwards selection (active < anchor) is normalised', () => {
    const units = resolveExecution(SOURCE, { anchor: 18, active: 10 });
    expect(units[0]!.text).toBe('SELECT 2');
  });

  test('a selection spanning two statements runs them as a single unit', () => {
    // Selecting across the `;` runs the multi-statement text verbatim.
    const units = resolveExecution(SOURCE, { anchor: 0, active: 18 });
    expect(units).toHaveLength(1);
    expect(units[0]!.text).toBe('SELECT 1;\nSELECT 2');
  });

  test('whitespace-only selection yields nothing', () => {
    const src = 'SELECT 1;   \nSELECT 2';
    const units = resolveExecution(src, { anchor: 9, active: 12 });
    expect(units).toEqual([]);
  });

  test('selection with leading whitespace re-anchors to the first real char', () => {
    const src = '   SELECT 9';
    const units = resolveExecution(src, { anchor: 0, active: src.length });
    expect(units[0]!.text).toBe('SELECT 9');
    expect(src.slice(units[0]!.start, units[0]!.end)).toBe('SELECT 9');
  });
});

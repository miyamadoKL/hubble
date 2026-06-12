import { describe, expect, test } from 'vitest';
import { splitStatements } from './splitStatements';

describe('splitStatements', () => {
  test('returns nothing for empty / whitespace-only input', () => {
    expect(splitStatements('')).toEqual([]);
    expect(splitStatements('   \n\t ')).toEqual([]);
  });

  test('single statement (no trailing semicolon) → one slice spanning it', () => {
    const slices = splitStatements('SELECT 1');
    expect(slices).toHaveLength(1);
    expect(slices[0]).toEqual({ text: 'SELECT 1', start: 0, end: 8 });
  });

  test('splits on top-level semicolons and trims each segment', () => {
    const slices = splitStatements('SELECT 1; SELECT 2;');
    expect(slices.map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
    // Offsets point at the (trimmed) statement text in the source.
    expect(slices[0]).toMatchObject({ start: 0, end: 8 });
    expect(slices[1]).toMatchObject({ start: 10, end: 18 });
  });

  test('a trailing semicolon does not create an empty final statement', () => {
    expect(splitStatements('SELECT 1;')).toHaveLength(1);
    expect(splitStatements('SELECT 1 ;\n').map((s) => s.text)).toEqual(['SELECT 1']);
  });

  test('semicolons inside string literals are not separators', () => {
    const slices = splitStatements("SELECT ';' AS x; SELECT 2");
    expect(slices.map((s) => s.text)).toEqual(["SELECT ';' AS x", 'SELECT 2']);
  });

  test('semicolons inside comments are not separators', () => {
    const slices = splitStatements('SELECT 1 -- a; b\n; SELECT 2');
    expect(slices.map((s) => s.text)).toEqual(['SELECT 1 -- a; b', 'SELECT 2']);
  });

  test('offsets are usable to slice the original source back out', () => {
    const source = '  SELECT a;\nSELECT b';
    const slices = splitStatements(source);
    for (const s of slices) {
      expect(source.slice(s.start, s.end)).toBe(s.text);
    }
  });
});

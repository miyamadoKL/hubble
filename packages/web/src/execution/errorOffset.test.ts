import { describe, expect, test } from 'vitest';
import { correctErrorPosition, offsetToPosition } from './errorOffset';

const SOURCE = 'SELECT 1;\nSELECT * FROM no_such_table;\nSELECT 3';

describe('offsetToPosition', () => {
  test('start of source is line 1, column 1', () => {
    expect(offsetToPosition(SOURCE, 0)).toEqual({ line: 1, column: 1 });
  });

  test('mid first line', () => {
    expect(offsetToPosition(SOURCE, 7)).toEqual({ line: 1, column: 8 });
  });

  test('start of second line (after the first \\n)', () => {
    // Offset 10 is the 'S' of the second SELECT.
    expect(offsetToPosition(SOURCE, 10)).toEqual({ line: 2, column: 1 });
  });

  test('third line', () => {
    const offset = SOURCE.lastIndexOf('SELECT 3');
    expect(offsetToPosition(SOURCE, offset)).toEqual({ line: 3, column: 1 });
  });
});

describe('correctErrorPosition', () => {
  test('error on the first line of a statement shifts the column by its start col', () => {
    // The second statement starts at offset 10 (line 2, col 1). A Trino error at
    // statement line 1, column 15 ("no_such_table") maps to source line 2, col 15.
    const unitStart = SOURCE.indexOf('SELECT * FROM');
    const pos = correctErrorPosition(SOURCE, unitStart, 1, 15);
    expect(pos).toEqual({ line: 2, column: 15 });
  });

  test('a statement that itself starts mid-line offsets the column', () => {
    // Selection-run: "FROM no_such_table" begins at column 10 of line 2.
    const src = 'SELECT *  FROM bad';
    const unitStart = src.indexOf('FROM'); // offset 10 → line1 col 11
    const pos = correctErrorPosition(src, unitStart, 1, 6); // 6th char of "FROM bad" → "b"
    // base col = 11, plus (6-1) = 16.
    expect(pos).toEqual({ line: 1, column: 16 });
  });

  test('error on a later line of the statement maps straight through with line base', () => {
    // Statement begins on source line 2; an error at statement line 2 (its 2nd
    // line) lands on source line 3, keeping the reported column.
    const src = 'SELECT 1;\nSELECT a,\n  bad_col\nFROM t';
    const unitStart = src.indexOf('SELECT a'); // line 2, col 1
    const pos = correctErrorPosition(src, unitStart, 2, 3); // "bad_col" line
    expect(pos).toEqual({ line: 3, column: 3 });
  });
});

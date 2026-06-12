// Map a query error's (line, column) — reported relative to the *statement text*
// that was sent to Trino — back onto the cell's full source, so Monaco markers
// land on the right characters even when the statement was one of several in the
// cell (design.md §5: 複数ステートメント実行時はオフセット補正).
//
// Trino positions are 1-based line/column. The statement begins at character
// offset `unitStart` in the source. We convert that offset to a (line, col)
// base, then add the statement-relative position: the first statement line maps
// onto the statement's starting line (column offset applied), subsequent lines
// map straight through.

export interface SourcePosition {
  /** 1-based line in the full source. */
  line: number;
  /** 1-based column in the full source. */
  column: number;
}

/** The (1-based) line/column of a 0-based character offset within `source`. */
export function offsetToPosition(source: string, offset: number): SourcePosition {
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lastNewline = -1;
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastNewline = i;
    }
  }
  return { line, column: clamped - lastNewline };
}

/**
 * Translate a statement-relative (1-based) line/column into a source-relative
 * position. `unitStart` is the 0-based offset of the statement in the source.
 * On the statement's first line the column is shifted by the statement's start
 * column; later lines keep their column but shift by the line base.
 */
export function correctErrorPosition(
  source: string,
  unitStart: number,
  stmtLine: number,
  stmtColumn: number,
): SourcePosition {
  const base = offsetToPosition(source, unitStart);
  if (stmtLine <= 1) {
    return { line: base.line, column: base.column + (stmtColumn - 1) };
  }
  return { line: base.line + (stmtLine - 1), column: stmtColumn };
}

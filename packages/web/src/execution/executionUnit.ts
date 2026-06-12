// Resolve *what* to run from the editor state (design.md §5 実行単位の決定):
//
//   - a non-empty selection  → run exactly the selected text (one unit)
//   - otherwise              → run the statement under the caret (one unit)
//   - "run whole cell"       → every statement, in order (handled by `allUnits`)
//
// Everything here is pure and offset-based (0-based character indices into the
// source), so it is unit-testable without Monaco. The editor layer converts
// Monaco positions → offsets before calling in.

import { splitStatements, type StatementSlice } from '../trino-lang';

/** One thing to execute: its text plus the offset span it occupies in source. */
export interface ExecutionUnit {
  text: string;
  /** 0-based [start, end) offsets into the original source. */
  start: number;
  end: number;
}

export interface CaretSelection {
  /** Caret/anchor offsets into the source. Equal when there is no selection. */
  anchor: number;
  active: number;
}

function sliceToUnit(slice: StatementSlice): ExecutionUnit {
  return { text: slice.text, start: slice.start, end: slice.end };
}

/** Every non-empty statement in `source`, in document order. */
export function allUnits(source: string): ExecutionUnit[] {
  return splitStatements(source).map(sliceToUnit);
}

/**
 * The statement that contains `offset`. When the caret sits between statements
 * (e.g. on the blank line after a `;`), the *nearest preceding* statement wins;
 * if there is none, the first statement is used. Returns undefined only when the
 * source has no statements at all.
 */
export function statementAtOffset(source: string, offset: number): ExecutionUnit | undefined {
  const slices = splitStatements(source);
  if (slices.length === 0) return undefined;

  // Inside a statement's span (inclusive of its end so a caret at end-of-text
  // still maps to the last statement).
  for (const slice of slices) {
    if (offset >= slice.start && offset <= slice.end) return sliceToUnit(slice);
  }
  // Between statements: pick the last one that ends at/before the caret.
  let candidate = slices[0]!;
  for (const slice of slices) {
    if (slice.start <= offset) candidate = slice;
    else break;
  }
  return sliceToUnit(candidate);
}

/**
 * Resolve the execution unit(s) for a Ctrl/Cmd+Enter / gutter run, given the
 * current selection and caret. A non-empty selection runs only that text as a
 * single unit (its span is the raw selection so error offsets map back exactly);
 * otherwise the statement under the caret runs.
 */
export function resolveExecution(source: string, selection: CaretSelection): ExecutionUnit[] {
  const start = Math.min(selection.anchor, selection.active);
  const end = Math.max(selection.anchor, selection.active);

  if (end > start) {
    const text = source.slice(start, end).trim();
    if (text.length === 0) return [];
    // Re-anchor the trimmed span so reported error offsets land on real chars.
    const leading = source.slice(start, end).length - source.slice(start, end).trimStart().length;
    const unitStart = start + leading;
    return [{ text, start: unitStart, end: unitStart + text.length }];
  }

  const unit = statementAtOffset(source, start);
  return unit ? [unit] : [];
}

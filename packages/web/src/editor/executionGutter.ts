// Monaco glue for the per-statement execution gutter + execution-error markers
// (design.md §5). Pure Monaco/decoration plumbing; the cell component owns the
// state and calls these to project it into the editor.
//
//   - applyStatementGutter : glyph-margin status icons per statement, derived
//                            from splitStatements offsets + a status map, with
//                            the caret's statement marked `active`.
//   - setExecutionMarkers  : surface an execution error's corrected line/column
//                            as an Error marker (its own owner, so it coexists
//                            with the P3a syntax markers).

import type * as monaco from 'monaco-editor';
import { splitStatements } from '../trino-lang';
import { correctErrorPosition } from '../execution';
import type { ApiErrorDetail } from '@hubble/contracts';

export const EXEC_MARKER_OWNER = 'trino-exec';

/** Per-statement run status (mirrors the gutter icons). */
export type StatementStatus = 'idle' | 'active' | 'executing' | 'done' | 'failed';

const STATUS_GLYPH: Record<StatementStatus, string> = {
  idle: 'trino-gutter-idle',
  active: 'trino-gutter-active',
  executing: 'trino-gutter-executing',
  done: 'trino-gutter-done',
  failed: 'trino-gutter-failed',
};

export interface StatementGutterEntry {
  /** 0-based [start, end) offset of the statement in the source. */
  start: number;
  end: number;
  status: StatementStatus;
}

/** Convert a 0-based source offset to a Monaco position via the model. */
function offsetPosition(model: monaco.editor.ITextModel, offset: number): monaco.IPosition {
  return model.getPositionAt(offset);
}

/**
 * Compute one gutter entry per statement: the statement under the caret is
 * `active` unless it has a more specific status (executing/done/failed) keyed by
 * its start offset in `statuses`.
 */
export function computeGutterEntries(
  source: string,
  caretOffset: number,
  statuses: Map<number, StatementStatus>,
): StatementGutterEntry[] {
  const slices = splitStatements(source);
  return slices.map((slice) => {
    const explicit = statuses.get(slice.start);
    const isActive = caretOffset >= slice.start && caretOffset <= slice.end;
    const status: StatementStatus = explicit ?? (isActive ? 'active' : 'idle');
    return { start: slice.start, end: slice.end, status };
  });
}

/**
 * Apply gutter glyph decorations to `collection`. Each statement gets a single
 * glyph on its first line. Returns nothing; mutates the collection in place.
 */
export function applyStatementGutter(
  monacoNs: typeof monaco,
  model: monaco.editor.ITextModel,
  collection: monaco.editor.IEditorDecorationsCollection,
  entries: StatementGutterEntry[],
): void {
  const decos: monaco.editor.IModelDeltaDecoration[] = entries.map((entry) => {
    const pos = offsetPosition(model, entry.start);
    return {
      range: new monacoNs.Range(pos.lineNumber, 1, pos.lineNumber, 1),
      options: {
        isWholeLine: false,
        glyphMarginClassName: STATUS_GLYPH[entry.status],
        glyphMarginHoverMessage: { value: `Statement: ${entry.status}` },
        stickiness: monacoNs.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      },
    };
  });
  collection.set(decos);
}

/**
 * Surface an execution error as a Monaco marker, with its (line, column)
 * corrected from statement-relative to source-relative coordinates.
 * `unitStart` is the statement's 0-based offset in the source.
 */
export function setExecutionMarkers(
  monacoNs: typeof monaco,
  model: monaco.editor.ITextModel,
  error: ApiErrorDetail | undefined,
  unitStart: number,
): void {
  if (!error || error.line === undefined) {
    monacoNs.editor.setModelMarkers(model, EXEC_MARKER_OWNER, []);
    return;
  }
  const source = model.getValue();
  const { line, column } = correctErrorPosition(
    source,
    unitStart,
    error.line,
    error.column ?? 1,
  );
  // Underline to the end of the offending token/line.
  const lineMaxColumn = model.getLineMaxColumn(Math.min(line, model.getLineCount()));
  monacoNs.editor.setModelMarkers(model, EXEC_MARKER_OWNER, [
    {
      severity: monacoNs.MarkerSeverity.Error,
      message: error.trinoErrorName ? `${error.trinoErrorName}: ${error.message}` : error.message,
      startLineNumber: line,
      startColumn: column,
      endLineNumber: line,
      endColumn: Math.max(column + 1, lineMaxColumn),
    },
  ]);
}

/** Clear execution markers (e.g. on a fresh run). */
export function clearExecutionMarkers(
  monacoNs: typeof monaco,
  model: monaco.editor.ITextModel,
): void {
  monacoNs.editor.setModelMarkers(model, EXEC_MARKER_OWNER, []);
}

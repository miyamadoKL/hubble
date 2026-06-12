// Forked from trino-query-ui (Apache-2.0). See repo-root NOTICE.
// Adapted for hubble: typed against antlr4ng's BaseErrorListener (the
// original used `any` throughout and a magic `severity: 8`). Emits
// editor-agnostic marker objects (1-based line/column, matching Monaco) so the
// language layer stays free of any monaco-editor import.

import {
  type ATNSimulator,
  BaseErrorListener,
  type RecognitionException,
  type Recognizer,
  type Token,
} from 'antlr4ng';

/**
 * Editor-agnostic syntax-error marker. Coordinates are 1-based to match
 * Monaco's `IMarkerData`. `endColumn` is exclusive.
 */
export interface TrinoSqlMarker {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
}

class SqlBaseErrorListener extends BaseErrorListener {
  private readonly markers: TrinoSqlMarker[] = [];

  getMarkers(): TrinoSqlMarker[] {
    return this.markers;
  }

  override syntaxError(
    _recognizer: Recognizer<ATNSimulator> | null,
    offendingSymbol: Token | null,
    line: number,
    charPositionInLine: number,
    msg: string,
    _e: RecognitionException | null,
  ): void {
    // Width of the offending token (>= 1) so the squiggle covers it.
    const width =
      offendingSymbol && offendingSymbol.stop >= offendingSymbol.start
        ? Math.max(1, offendingSymbol.stop - offendingSymbol.start + 1)
        : 1;
    this.markers.push({
      startLineNumber: line,
      startColumn: charPositionInLine + 1,
      endLineNumber: line,
      endColumn: charPositionInLine + 1 + width,
      message: msg,
    });
  }
}

export default SqlBaseErrorListener;

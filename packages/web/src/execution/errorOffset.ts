// Map a query error's (line, column) — reported relative to the *statement text*
// that was sent to Trino — back onto the cell's full source, so Monaco markers
// land on the right characters even when the statement was one of several in the
// cell (複数ステートメント実行時はオフセット補正).
//
// Trino positions are 1-based line/column. The statement begins at character
// offset `unitStart` in the source. We convert that offset to a (line, col)
// base, then add the statement-relative position: the first statement line maps
// onto the statement's starting line (column offset applied), subsequent lines
// map straight through.
//
// ==== ファイルの責務（日本語） ================================================
// Trino がエラーとして報告する (line, column) は「実際に送信したステートメント
// テキスト」を基準とした 1-based の位置。しかし、そのステートメントがセル内の
// 複数文のうち 1 つに過ぎない場合、Monaco のエラーマーカーはセル全体のソース
// 座標系で表示する必要がある。本ファイルは、その 2 つの座標系の変換を行う。
//   - offsetToPosition   : ソース中の 0-based 文字オフセットを 1-based の
//                          (line, column) に変換する基礎関数。
//   - correctErrorPosition: ステートメント相対の (line, column) を、ステートメント
//                          の開始オフセット (unitStart) を使ってセル全体の
//                          ソース相対座標へ補正する。
// ============================================================================

export interface SourcePosition {
  /** 1-based line in the full source. */
  /** セル全体のソースにおける 1-based の行番号。 */
  line: number;
  /** 1-based column in the full source. */
  /** セル全体のソースにおける 1-based の列番号。 */
  column: number;
}

/**
 * The (1-based) line/column of a 0-based character offset within `source`.
 * 0-based の文字オフセットを、`source` 内の 1-based (line, column) に変換する。
 */
export function offsetToPosition(source: string, offset: number): SourcePosition {
  // offset がソース長を超える/負の場合に備えて範囲内へクランプする。
  const clamped = Math.max(0, Math.min(offset, source.length));
  let line = 1;
  let lastNewline = -1;
  // clamped 手前までの改行を数え、行数と直近の改行位置を求める。
  for (let i = 0; i < clamped; i++) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line++;
      lastNewline = i;
    }
  }
  // column は「直近の改行の次の文字」からの相対位置（1-based）。
  return { line, column: clamped - lastNewline };
}

/**
 * Translate a statement-relative (1-based) line/column into a source-relative
 * position. `unitStart` is the 0-based offset of the statement in the source.
 * On the statement's first line the column is shifted by the statement's start
 * column; later lines keep their column but shift by the line base.
 *
 * ステートメント相対の (1-based) line/column を、セル全体のソース相対の位置へ
 * 変換する。`unitStart` はソース中でのステートメント開始位置（0-based
 * オフセット）。エラーがステートメントの 1 行目で発生した場合は、その行の
 * 開始列ぶん列をずらす必要がある（ステートメントが行の途中から始まっている
 * ため）。2 行目以降であれば列はそのままでよく、行番号だけをステートメント
 * 開始行の分だけシフトすればよい。
 */
export function correctErrorPosition(
  source: string,
  unitStart: number,
  stmtLine: number,
  stmtColumn: number,
): SourcePosition {
  // ステートメントの開始位置をセル全体の座標系での (line, column) に変換する。
  const base = offsetToPosition(source, unitStart);
  if (stmtLine <= 1) {
    // エラーがステートメントの 1 行目: 開始列からの相対位置として列を加算する。
    return { line: base.line, column: base.column + (stmtColumn - 1) };
  }
  // エラーが 2 行目以降: 列はそのまま、行だけステートメント開始行の分シフトする。
  return { line: base.line + (stmtLine - 1), column: stmtColumn };
}

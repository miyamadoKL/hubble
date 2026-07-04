// Monaco glue for the per-statement execution gutter + execution-error markers.
// Pure Monaco/decoration plumbing; the cell component owns the
// state and calls these to project it into the editor.
//
//   - applyStatementGutter : glyph-margin status icons per statement, derived
//                            from splitStatements offsets + a status map, with
//                            the caret's statement marked `active`.
//   - setExecutionMarkers  : surface an execution error's corrected line/column
//                            as an Error marker (its own owner, so it coexists
//                            with the P3a syntax markers).
//
// ---- ファイル概要（日本語） ----
// ステートメント単位の実行状態ガター（グリフマージンのアイコン）と、実行時エラーの
// マーカー表示を Monaco へ橋渡しするモジュール。状態そのものはセルコンポーネント側が
// 保持し、このモジュールは純粋に Monaco の装飾/マーカー API を操作するだけ。
//   - applyStatementGutter : splitStatements で求めたステートメント範囲 + 状態マップから、
//                            グリフマージンのアイコンを描画する。カーソル位置のステートメントは
//                            「active」として扱う。
//   - setExecutionMarkers  : 実行時エラーの line/column をソース全体の座標へ補正した上で、
//                            Error マーカーとして表示する。構文エラーマーカー（P3a）とは
//                            別 owner にすることで共存させる。

import type * as monaco from 'monaco-editor';
import { splitStatements } from '../trino-lang';
import { correctErrorPosition } from '../execution';
import type { ApiErrorDetail } from '@hubble/contracts';

/** 実行時エラーマーカーの owner 文字列（構文エラーマーカーの owner とは別にして共存させる）。 */
export const EXEC_MARKER_OWNER = 'trino-exec';

/** Per-statement run status (mirrors the gutter icons). */
/** ステートメントごとの実行状態（ガターアイコンの見た目に対応する）。 */
export type StatementStatus = 'idle' | 'active' | 'executing' | 'done' | 'failed';

// 状態ごとに割り当てるグリフマージン用 CSS クラス名。
const STATUS_GLYPH: Record<StatementStatus, string> = {
  idle: 'trino-gutter-idle',
  active: 'trino-gutter-active',
  executing: 'trino-gutter-executing',
  done: 'trino-gutter-done',
  failed: 'trino-gutter-failed',
};

/** 1 つのステートメントに対応するガターエントリ。 */
export interface StatementGutterEntry {
  /** 0-based [start, end) offset of the statement in the source. */
  /** ソース全文中でのステートメントの [start, end) オフセット（0 始まり）。 */
  start: number;
  end: number;
  status: StatementStatus;
}

/** Convert a 0-based source offset to a Monaco position via the model. */
/** 0 始まりのソースオフセットを、モデル経由で Monaco の行と列の位置に変換する。 */
function offsetPosition(model: monaco.editor.ITextModel, offset: number): monaco.IPosition {
  return model.getPositionAt(offset);
}

/**
 * Compute one gutter entry per statement: the statement under the caret is
 * `active` unless it has a more specific status (executing/done/failed) keyed by
 * its start offset in `statuses`.
 *
 * ステートメントごとに 1 つのガターエントリを計算する。カーソル位置のステートメントは、
 * `statuses`（開始オフセットをキーにした状態マップ）により executing/done/failed の
 * ような具体的な状態が設定されていない限り `active` として扱う。
 */
export function computeGutterEntries(
  source: string,
  caretOffset: number,
  statuses: Map<number, StatementStatus>,
): StatementGutterEntry[] {
  // `;` 区切りでステートメント単位に分割する（trino-lang の splitStatements を利用）。
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
 *
 * ガターのグリフ装飾を `collection` に反映する。各ステートメントの先頭行に 1 つだけ
 * グリフを表示する。戻り値はなく、渡された decorations collection を破壊的に更新する。
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
        // 編集境界での自動拡張を防ぎ、タイピング中に範囲がずれないようにする。
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
 *
 * 実行時エラーを Monaco のマーカーとして表示する。Trino から返る (line, column) は
 * 実行単位（ステートメント）内の相対座標なので、`unitStart`（ステートメントのソース中の
 * 0 始まりオフセット）を使ってソース全体の座標へ補正してから表示する。
 */
export function setExecutionMarkers(
  monacoNs: typeof monaco,
  model: monaco.editor.ITextModel,
  error: ApiErrorDetail | undefined,
  unitStart: number,
): void {
  // エラーがない、または行番号が取れない場合はマーカーをクリアするだけ。
  if (!error || error.line === undefined) {
    monacoNs.editor.setModelMarkers(model, EXEC_MARKER_OWNER, []);
    return;
  }
  const source = model.getValue();
  // ステートメント相対座標 → ソース全体座標への補正（execution モジュールに委譲）。
  const { line, column } = correctErrorPosition(source, unitStart, error.line, error.column ?? 1);
  // Underline to the end of the offending token/line.
  // 問題のトークン/行末までを下線表示範囲とする。
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
/** 実行時エラーマーカーをクリアする（例: 再実行の開始時）。 */
export function clearExecutionMarkers(
  monacoNs: typeof monaco,
  model: monaco.editor.ITextModel,
): void {
  monacoNs.editor.setModelMarkers(model, EXEC_MARKER_OWNER, []);
}

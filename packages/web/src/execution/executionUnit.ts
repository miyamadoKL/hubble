// Resolve *what* to run from the editor state (design.md §5 実行単位の決定):
//
//   - a non-empty selection  → run exactly the selected text (one unit)
//   - otherwise              → run the statement under the caret (one unit)
//   - "run whole cell"       → every statement, in order (handled by `allUnits`)
//
// Everything here is pure and offset-based (0-based character indices into the
// source), so it is unit-testable without Monaco. The editor layer converts
// Monaco positions → offsets before calling in.
//
// ==== ファイルの責務（日本語） ================================================
// エディタの状態（キャレット位置と選択範囲）から「何を実行するか（実行単位）」
// を決定するロジック。
//   - 選択範囲が非空 → 選択されたテキストをそのまま 1 個の実行単位として実行
//   - それ以外       → キャレット位置を含むステートメントを 1 個の実行単位として実行
//   - 「セル全体を実行」 → セル内のすべてのステートメントを順に実行
//                          （`allUnits` が担当し、runUnits で逐次実行される）
// すべて純粋関数で、ソース中の 0-based 文字オフセットのみを扱うため、
// Monaco 無しに単体テストできる。Monaco の位置情報からオフセットへの変換は
// エディタ側の呼び出し元が行う。
// ============================================================================

import { splitStatements, type StatementSlice } from '../trino-lang';

/** One thing to execute: its text plus the offset span it occupies in source. */
/** 実行対象 1 個分: そのテキストと、ソース中で占める範囲（オフセット）。 */
export interface ExecutionUnit {
  text: string;
  /** 0-based [start, end) offsets into the original source. */
  /** 元のソースにおける 0-based の [start, end) 範囲。 */
  start: number;
  end: number;
}

/** キャレットおよび選択範囲を表す、ソース中のオフセットのペア。 */
export interface CaretSelection {
  /** Caret/anchor offsets into the source. Equal when there is no selection. */
  /** ソース中でのキャレット/アンカーのオフセット。選択が無ければ両者は等しい。 */
  anchor: number;
  active: number;
}

// StatementSlice（trino-lang のパーサーが返す生の分割結果）を、この
// モジュールの公開型 ExecutionUnit に変換するだけの小さなアダプタ。
function sliceToUnit(slice: StatementSlice): ExecutionUnit {
  return { text: slice.text, start: slice.start, end: slice.end };
}

/** Every non-empty statement in `source`, in document order. */
/** `source` 内のすべての非空ステートメントを、文書中の出現順で返す。 */
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
  // まず、いずれかのステートメントの範囲内に offset が入っているかを調べる
  // （end を含めているのは、テキスト末尾にキャレットがあっても最後の
  // ステートメントに対応付けられるようにするため）。
  for (const slice of slices) {
    if (offset >= slice.start && offset <= slice.end) return sliceToUnit(slice);
  }
  // Between statements: pick the last one that ends at/before the caret.
  // どのステートメントの範囲にも入っていない場合（＝ステートメント間の空白/
  // 改行上にキャレットがある場合）は、直前のステートメントを候補として選ぶ。
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
    // 選択範囲がある場合: その範囲のテキストをそのまま 1 個の実行単位にする。
    const text = source.slice(start, end).trim();
    if (text.length === 0) return [];
    // Re-anchor the trimmed span so reported error offsets land on real chars.
    // trim で先頭の空白を落とした分だけ start をずらし、エラー座標補正が
    // 実際の文字位置を指すようにする（先頭の空白ぶんのズレを補正）。
    const leading = source.slice(start, end).length - source.slice(start, end).trimStart().length;
    const unitStart = start + leading;
    return [{ text, start: unitStart, end: unitStart + text.length }];
  }

  // 選択範囲が無い（キャレットのみ）場合: キャレットを含むステートメントを実行する。
  const unit = statementAtOffset(source, start);
  return unit ? [unit] : [];
}

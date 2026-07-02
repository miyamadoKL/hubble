// Typed against antlr4ng's BaseErrorListener. Emits editor-agnostic marker
// objects (1-based line/column, matching Monaco) so the language layer stays
// free of any monaco-editor import.
//
// ---- ファイル概要（日本語） ----
// antlr4ng の `BaseErrorListener` を継承し、ANTLR パーサーが構文エラーを検出する
// たびに呼ばれる `syntaxError` をオーバーライドして、エラー内容を蓄積する
// リスナークラス。ANTLR 独自のエラー情報をそのまま公開するのではなく、Monaco の
// `IMarkerData` と互換性のある「エディターに依存しない」プレーンなマーカー
// オブジェクト（TrinoSqlMarker）に変換して保持する。これにより analyzer.ts などの
// 言語処理層は monaco-editor を import せずに済む。

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
 *
 * エディターに依存しない構文エラーマーカー。座標は Monaco の `IMarkerData` に
 * 合わせて 1 始まり（1-based）。`endColumn` は終端排他。
 */
export interface TrinoSqlMarker {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
}

/**
 * antlr4ng の構文エラーを蓄積し、Monaco 互換のマーカー配列として取り出せる
 * エラーリスナー。パーサーに `addErrorListener` で登録して使う。
 */
class SqlBaseErrorListener extends BaseErrorListener {
  // これまでに検出された構文エラーのマーカーを蓄積する配列。
  private readonly markers: TrinoSqlMarker[] = [];

  /** これまでに蓄積された構文エラーマーカーの一覧を返す。 */
  getMarkers(): TrinoSqlMarker[] {
    return this.markers;
  }

  // ANTLR パーサーが構文エラーを検出するたびに呼ばれるコールバック。
  // ここでエラー位置、幅、メッセージから TrinoSqlMarker を組み立てて蓄積する。
  override syntaxError(
    _recognizer: Recognizer<ATNSimulator> | null,
    offendingSymbol: Token | null,
    line: number,
    charPositionInLine: number,
    msg: string,
    _e: RecognitionException | null,
  ): void {
    // Width of the offending token (>= 1) so the squiggle covers it.
    // エラーの原因となったトークンの幅（最低でも 1 文字）を計算し、Monaco の赤波線
    // （squiggle）がそのトークン全体を覆うようにする。トークンが取れない場合は
    // 幅 1 にフォールバックする。
    const width =
      offendingSymbol && offendingSymbol.stop >= offendingSymbol.start
        ? Math.max(1, offendingSymbol.stop - offendingSymbol.start + 1)
        : 1;
    // ANTLR は line が 1 始まり、charPositionInLine が 0 始まりで返すため、
    // Monaco の 1 始まり列番号に合わせて +1 する。
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

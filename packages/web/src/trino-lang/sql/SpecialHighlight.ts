// Emits a plain descriptor (range + class + resolved TableReference) rather
// than importing monaco-editor or a singleton SchemaProvider directly. The
// editor layer (registerTrinoLanguage) turns the descriptor into a Monaco
// decoration and resolves hover text through the injected SchemaCache.
//
// 日本語: このファイルは SqlBaseListenerImpl がパースツリー走査中に見つけた
// 「特別にハイライトすべき箇所」（テーブル名の qualifiedName など）を表す。
// monaco-editor やシングルトンの SchemaProvider を直接 import せず、単純な
// descriptor（範囲 + CSS クラス + 解決済み TableReference）を組み立てて返すだけに
// とどめている。エディタ層（registerTrinoLanguage）がこの descriptor を Monaco の
// デコレーションに変換し、ホバーテキストは注入された SchemaCache 経由で解決する。

import type { ParserRuleContext } from 'antlr4ng';
import TableReference from '../schema/TableReference';

/**
 * 1-based, end-exclusive range (Monaco-compatible).
 *
 * 1-based（1 始まり）・終端排他の範囲。Monaco のレンジ表現と互換性がある。
 */
export interface HighlightRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/**
 * Editor-agnostic decoration descriptor produced from the parse tree.
 *
 * パースツリーから生成された、エディタに依存しないデコレーション記述子。
 */
export interface HighlightDescriptor {
  range: HighlightRange;
  /** CSS class applied inline (e.g. 'qualifiedName' or 'relationReference'). */
  inlineClassName: string;
  /** The table this name resolves to, if catalog/schema context is known. */
  tableReference?: TableReference;
}

/**
 * パースツリー中で見つかった 1 箇所のハイライト対象（テーブル名など）を表す。
 * 位置情報（ANTLR の 0-based 行と列）と、それが属するカタログ/スキーマの文脈、
 * および元になったパースツリーのノードを保持する。
 */
class SpecialHighlight {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  kind: string;
  ast: ParserRuleContext;
  catalog?: string;
  schema?: string;

  constructor(
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number,
    kind: string,
    ast: ParserRuleContext,
    catalog?: string,
    schema?: string,
  ) {
    this.startLineNumber = startLineNumber;
    this.startColumn = startColumn;
    this.endLineNumber = endLineNumber;
    this.endColumn = endColumn;
    this.kind = kind;
    this.ast = ast;
    this.catalog = catalog;
    this.schema = schema;
  }

  /**
   * Resolve this highlight to an editor-agnostic decoration descriptor.
   *
   * このハイライト箇所を、エディタに依存しないデコレーション記述子に変換する。
   */
  getDescriptor(namedQueries: Map<string, string>): HighlightDescriptor {
    const name = this.ast.getText();
    // 名前が CTE/エイリアス（namedQueries）に一致すればリレーション参照として、
    // そうでなければ既定の kind（例: 'qualifiedName'）としてスタイルを割り当てる。
    const inlineClassName = namedQueries.has(name) ? 'relationReference' : this.kind;

    // 完全修飾名ならそのまま解決し、そうでなければ現在のカタログ/スキーマ文脈が
    // 分かっている場合に限りテーブル参照を組み立てる（文脈不明なら未解決のまま）。
    let tableReference: TableReference | undefined;
    if (TableReference.isFullyQualified(name)) {
      tableReference = TableReference.fromFullyQualified(name);
    } else if (this.catalog && this.schema) {
      tableReference = new TableReference(this.catalog, this.schema, name);
    }

    return {
      // The listener supplies 0-based ANTLR columns; convert to Monaco 1-based.
      range: {
        startLineNumber: this.startLineNumber,
        startColumn: this.startColumn + 1,
        endLineNumber: this.endLineNumber,
        endColumn: this.endColumn + 2,
      },
      inlineClassName,
      tableReference,
    };
  }
}

export default SpecialHighlight;

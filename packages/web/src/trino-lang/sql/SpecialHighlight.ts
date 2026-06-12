// Forked from trino-query-ui (Apache-2.0). See repo-root NOTICE.
// Substantially adapted for hubble: the original imported monaco-editor and
// the singleton SchemaProvider directly to build a decoration with an inline
// hover string. To keep the language layer editor-agnostic and DI-friendly,
// this now emits a plain descriptor (range + class + resolved TableReference);
// the editor layer (registerTrinoLanguage) turns it into a Monaco decoration
// and resolves hover text through the injected SchemaCache.

import type { ParserRuleContext } from 'antlr4ng';
import TableReference from '../schema/TableReference';

/** 1-based, end-exclusive range (Monaco-compatible). */
export interface HighlightRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

/** Editor-agnostic decoration descriptor produced from the parse tree. */
export interface HighlightDescriptor {
  range: HighlightRange;
  /** CSS class applied inline (e.g. 'qualifiedName' or 'relationReference'). */
  inlineClassName: string;
  /** The table this name resolves to, if catalog/schema context is known. */
  tableReference?: TableReference;
}

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

  /** Resolve this highlight to an editor-agnostic decoration descriptor. */
  getDescriptor(namedQueries: Map<string, string>): HighlightDescriptor {
    const name = this.ast.getText();
    const inlineClassName = namedQueries.has(name) ? 'relationReference' : this.kind;

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

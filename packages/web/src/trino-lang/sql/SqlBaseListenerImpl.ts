// Forked from trino-query-ui (Apache-2.0). See repo-root NOTICE.
// Adapted for hubble: removed the singleton SchemaProvider side-effects (the
// original called SchemaProvider.getTableIfCached during the walk to warm a
// global cache). Cache warming is now driven explicitly by the analyzer layer
// from the table references this listener exposes. Also typed the visitor
// callbacks and `getDescriptors` returns editor-agnostic descriptors.

import type { ParserRuleContext } from 'antlr4ng';
import { SqlBaseListener } from '../generated/SqlBaseListener.js';
import {
  IdentifierContext,
  type QualifiedNameContext,
  type QuerySpecificationContext,
  SelectSingleContext,
  TableNameContext,
  type UnquotedIdentifierContext,
} from '../generated/SqlBaseParser.js';
import SpecialHighlight, { type HighlightDescriptor } from './SpecialHighlight';
import NamedQuery from './NamedQuery';
import StatementDescriptor from './StatementDescriptor';

class SqlBaseListenerImpl extends SqlBaseListener {
  specialHighlights: SpecialHighlight[] = [];
  tableColumns: Map<string, string[]> = new Map<string, string[]>();
  namedQueries: Map<string, NamedQuery> = new Map<string, NamedQuery>();
  currentColumns: string[] = [];
  currentTableNameContext: string = '';
  statements: StatementDescriptor[] = [];

  currentCatalog?: string;
  currentSchema?: string;

  constructor(catalog?: string, schema?: string) {
    super();
    this.currentCatalog = catalog;
    this.currentSchema = schema;
  }

  override exitQualifiedName = (ctx: QualifiedNameContext) => {
    if (!(ctx.parent instanceof TableNameContext)) return;
    if (!ctx.start || !ctx.stop) return;

    this.specialHighlights.push(
      new SpecialHighlight(
        ctx.start.line,
        ctx.start.column,
        ctx.stop.line,
        ctx.stop.column + (ctx.stop.stop - ctx.stop.start),
        'qualifiedName',
        ctx,
        this.currentCatalog,
        this.currentSchema,
      ),
    );

    const name = ctx.getText();
    this.currentTableNameContext = name;
    this.tableColumns.set(name, this.currentColumns);
    this.currentColumns = [];
  };

  override enterQuerySpecification = (_ctx: QuerySpecificationContext) => {
    this.currentTableNameContext = '';
  };

  override exitQuerySpecification = (ctx: QuerySpecificationContext) => {
    if (this.currentTableNameContext !== '' && ctx.start && ctx.stop) {
      this.statements.push(
        new StatementDescriptor(this.currentTableNameContext, ctx.start, ctx.stop),
      );
    }
  };

  // The name of a CTE.
  override exitNamedQuery = (ctx: ParserRuleContext) => {
    const first = ctx.children?.[0];
    if (first instanceof IdentifierContext) {
      const name = first.getText();
      this.namedQueries.set(name, new NamedQuery(name, ctx));
      this.tableColumns.set(name, this.currentColumns);
      this.currentColumns = [];
    }
  };

  // The name of an aliased relation.
  override exitAliasedRelation = (ctx: ParserRuleContext) => {
    const alias = ctx.children?.[2];
    if (alias instanceof IdentifierContext) {
      const name = alias.getText();
      this.namedQueries.set(name, new NamedQuery(name, ctx));
      this.tableColumns.set(name, this.currentColumns);
      this.currentColumns = [];
    }
  };

  override exitUnquotedIdentifier = (ctx: UnquotedIdentifierContext) => {
    // Walk up to the enclosing SelectSingle to detect a column alias.
    let current: ParserRuleContext | null = ctx;
    while (current && !(current instanceof SelectSingleContext)) {
      current = current.parent;
    }
    if (!current) return;

    const children = current.children ?? [];
    if (children.length > 1) {
      const last = children[children.length - 1];
      if (last) this.currentColumns.push(last.getText());
    } else {
      this.currentColumns.push(ctx.getText());
    }
  };

  /** Names referenceable as relations (CTE / aliased) → for completion. */
  getNamedQueryNames(): Map<string, string> {
    const map = new Map<string, string>();
    for (const name of this.namedQueries.keys()) map.set(name, name);
    return map;
  }

  /** Editor-agnostic decoration descriptors for every table-name highlight. */
  getDescriptors(): HighlightDescriptor[] {
    const named = this.getNamedQueryNames();
    return this.specialHighlights.map((h) => h.getDescriptor(named));
  }
}

export default SqlBaseListenerImpl;

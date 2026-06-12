// `analyzer.ts` is the synchronous, editor-agnostic heart of the language
// support. It exposes pure-ish functions used by the Monaco providers in
// ../editor/ and exercised directly by vitest (no monaco-editor import here):
//
//   parseStatement(sql)            -> markers + decoration descriptors
//   collectCompletions({...})      -> grammar + schema completion candidates
//
// Completion follows the "phantom cursor" approach: insert a sentinel
// identifier at the caret, run antlr4-c3 with preferredRules) and fold in
// schema candidates (table names + CTE names + columns of the in-context
// table) sourced from the synchronous SchemaCache.

import { CodeCompletionCore } from 'antlr4-c3';
import { CharStream, CommonTokenStream, Token } from 'antlr4ng';
import { SqlBaseLexer } from './generated/SqlBaseLexer.js';
import { SqlBaseParser } from './generated/SqlBaseParser.js';
import SqlBaseListenerImpl from './sql/SqlBaseListenerImpl';
import SqlBaseErrorListener, { type TrinoSqlMarker } from './sql/SqlBaseErrorListener';
import type { HighlightDescriptor } from './sql/SpecialHighlight';
import type { SchemaCache } from './sql/SchemaCache';
import TableReference from './schema/TableReference';

export type { TrinoSqlMarker } from './sql/SqlBaseErrorListener';
export type { HighlightDescriptor } from './sql/SpecialHighlight';

/** Sentinel identifier inserted at the caret for completion (phantom cursor). */
const PHANTOM = '__fable_caret__';

/** Editor-agnostic completion candidate. The editor maps these to Monaco. */
export interface CompletionCandidate {
  label: string;
  /** Text inserted on accept (defaults to label). */
  insertText: string;
  kind: 'keyword' | 'snippet' | 'table' | 'cte' | 'column' | 'columnList';
  detail?: string;
  /** Higher sorts first; lets schema items outrank raw keywords. */
  sortPriority?: number;
  /** True when insertText is a Monaco snippet (uses ${} placeholders). */
  isSnippet?: boolean;
}

export interface ParseResult {
  markers: TrinoSqlMarker[];
  descriptors: HighlightDescriptor[];
  /** Table references discovered in the statement (for cache warming). */
  tableReferences: TableReference[];
}

interface ParseInternals extends ParseResult {
  parser: SqlBaseParser;
  tokenStream: CommonTokenStream;
  listener: SqlBaseListenerImpl;
}

function buildParser(sql: string): {
  parser: SqlBaseParser;
  tokenStream: CommonTokenStream;
} {
  const input = CharStream.fromString(sql.length ? sql : ' ');
  const lexer = new SqlBaseLexer(input);
  lexer.removeErrorListeners();
  const tokenStream = new CommonTokenStream(lexer);
  const parser = new SqlBaseParser(tokenStream);
  return { parser, tokenStream };
}

function runParse(sql: string, catalog?: string, schema?: string): ParseInternals {
  const { parser, tokenStream } = buildParser(sql);
  const listener = new SqlBaseListenerImpl(catalog, schema);
  parser.addParseListener(listener);
  parser.removeErrorListeners();
  const errors = new SqlBaseErrorListener();
  parser.addErrorListener(errors);
  parser.singleStatement();
  tokenStream.fill();

  const tableReferences: TableReference[] = [];
  for (const stmt of listener.statements) {
    tableReferences.push(refFor(stmt.tableName, catalog, schema));
  }

  return {
    parser,
    tokenStream,
    listener,
    markers: errors.getMarkers(),
    descriptors: listener.getDescriptors(),
    tableReferences,
  };
}

/** Build a TableReference, honouring fully-qualified names and context. */
function refFor(name: string, catalog?: string, schema?: string): TableReference {
  if (TableReference.isFullyQualified(name)) return TableReference.fromFullyQualified(name);
  if (catalog && schema) return new TableReference(catalog, schema, name);
  return TableReference.fromFullyQualified(name);
}

/**
 * Parse a single statement for syntax markers + table-name decorations.
 * Never throws — a thrown error becomes a single line-1 marker.
 */
export function parseStatement(sql: string, catalog?: string, schema?: string): ParseResult {
  if (!sql.trim()) {
    return { markers: [], descriptors: [], tableReferences: [] };
  }
  try {
    const { markers, descriptors, tableReferences } = runParse(sql, catalog, schema);
    return { markers, descriptors, tableReferences };
  } catch (error) {
    return {
      markers: [
        {
          startLineNumber: 1,
          startColumn: 1,
          endLineNumber: 1,
          endColumn: 2,
          message: error instanceof Error ? error.message : 'SQL parse failed',
        },
      ],
      descriptors: [],
      tableReferences: [],
    };
  }
}

/** Insert the phantom identifier at `offset` (character index into `sql`). */
function insertPhantom(sql: string, offset: number): string {
  const clamped = Math.max(0, Math.min(offset, sql.length));
  return `${sql.slice(0, clamped)} ${PHANTOM} ${sql.slice(clamped)}`;
}

/**
 * Token index of the inserted phantom — that token *is* the caret for c3.
 * Locating it by text is far more robust than offset arithmetic (the phantom
 * insertion shifts every following token, and trailing-space carets otherwise
 * resolve to the wrong index). Falls back to the last real token.
 */
function caretTokenIndex(tokenStream: CommonTokenStream): number {
  const tokens = tokenStream.getTokens();
  const phantom = tokens.find((t) => t.text === PHANTOM);
  if (phantom) return phantom.tokenIndex;
  const real = tokens.filter((t) => t.type !== Token.EOF);
  return real.length ? real[real.length - 1]!.tokenIndex : 0;
}

/** Lowercased, human-readable label for a keyword token type. */
function keywordLabel(parser: SqlBaseParser, tokenType: number): string {
  const literal = parser.vocabulary.getLiteralName(tokenType);
  const symbolic = parser.vocabulary.getSymbolicName(tokenType);
  const raw = literal ?? symbolic ?? '';
  return raw.replace(/^'|'$/g, '').replace(/_/g, ' ').toLowerCase();
}

const PREFERRED_RULES = new Set<number>([
  SqlBaseParser.RULE_qualifiedName,
  SqlBaseParser.RULE_identifier,
  SqlBaseParser.RULE_relationPrimary,
  SqlBaseParser.RULE_expression,
]);

/** Snippet expansions keyed by the keyword that triggers them. */
const SNIPPETS: Record<string, { label: string; insertText: string; detail: string }> = {
  select: {
    label: 'select … from …',
    insertText: 'SELECT ${1:*}\nFROM ${2:table}',
    detail: 'snippet',
  },
  with: {
    label: 'with cte as (…)',
    insertText: 'WITH ${1:cte} AS (\n  SELECT ${2:*} FROM ${3:table}\n)\nSELECT * FROM ${1:cte}',
    detail: 'snippet',
  },
  limit: {
    label: 'limit 100',
    insertText: 'LIMIT ${1:100}',
    detail: 'snippet',
  },
};

export interface CompletionContext {
  sql: string;
  /** Character offset of the caret into `sql`. */
  offset: number;
  cache: SchemaCache;
  catalog?: string;
  schema?: string;
}

/**
 * Collect completion candidates at the caret. Synchronous: it reads whatever
 * the SchemaCache currently holds and fires async warmers as a side effect so
 * the next keystroke has more data. Never throws.
 */
export function collectCompletions(ctx: CompletionContext): CompletionCandidate[] {
  const { sql, offset, cache, catalog, schema } = ctx;
  try {
    const phantomSql = insertPhantom(sql, offset);
    const { parser, tokenStream } = buildParser(phantomSql);
    // Re-run the listener on the phantom text to know the in-context table.
    const listener = new SqlBaseListenerImpl(catalog, schema);
    parser.addParseListener(listener);
    parser.removeErrorListeners();
    parser.singleStatement();
    tokenStream.fill();

    const caretIndex = caretTokenIndex(tokenStream);
    const core = new CodeCompletionCore(parser);
    core.showDebugOutput = false;
    core.ignoredTokens = new Set([Token.EOF]);
    core.preferredRules = PREFERRED_RULES;
    const candidates = core.collectCandidates(caretIndex);

    const out: CompletionCandidate[] = [];
    const seen = new Set<string>();
    const push = (c: CompletionCandidate) => {
      const key = `${c.kind}:${c.label}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(c);
    };

    // 1. Keyword + snippet candidates from the grammar.
    let expectsRelation = false;
    let expectsExpression = false;
    for (const ruleIndex of candidates.rules.keys()) {
      if (
        ruleIndex === SqlBaseParser.RULE_qualifiedName ||
        ruleIndex === SqlBaseParser.RULE_relationPrimary
      ) {
        expectsRelation = true;
      }
      if (
        ruleIndex === SqlBaseParser.RULE_identifier ||
        ruleIndex === SqlBaseParser.RULE_expression
      ) {
        expectsExpression = true;
      }
    }

    for (const tokenType of candidates.tokens.keys()) {
      const label = keywordLabel(parser, tokenType);
      if (!label || label === 'eof' || label.startsWith('t__')) continue;
      // Skip pure punctuation keywords.
      if (!/[a-z]/.test(label)) continue;
      push({
        label,
        insertText: label,
        kind: 'keyword',
        detail: 'keyword',
        sortPriority: 1,
      });
      const snip = SNIPPETS[label];
      if (snip) {
        push({
          label: snip.label,
          insertText: snip.insertText,
          kind: 'snippet',
          detail: snip.detail,
          sortPriority: 5,
          isSnippet: true,
        });
      }
    }

    // 2. Relation candidates: table FQNs, context-relative names, CTE names.
    if (expectsRelation) {
      cache.warmCatalogs();
      if (catalog && schema) cache.warmTables(catalog, schema);

      for (const fqn of cache.getTableNameList()) {
        push({ label: fqn, insertText: fqn, kind: 'table', detail: 'table', sortPriority: 8 });
        // Relative name when it matches the current context.
        if (catalog && schema && fqn.startsWith(`${catalog}.${schema}.`)) {
          const rel = fqn.slice(`${catalog}.${schema}.`.length);
          push({
            label: rel,
            insertText: rel,
            kind: 'table',
            detail: 'table (context)',
            sortPriority: 9,
          });
        }
      }
      for (const cte of listener.namedQueries.keys()) {
        push({ label: cte, insertText: cte, kind: 'cte', detail: 'CTE', sortPriority: 10 });
      }
    }

    // 3. Column candidates from the in-context referenced table(s).
    if (expectsExpression || candidates.rules.has(SqlBaseParser.RULE_qualifiedName)) {
      for (const stmt of listener.statements) {
        const ref = refFor(stmt.tableName, catalog, schema);
        cache.warmTable(ref);
        const table = cache.getTableIfCached(ref);
        if (!table) continue;
        const cols = table.getColumns();
        for (const col of cols) {
          push({
            label: col.getName(),
            insertText: col.getName(),
            kind: 'column',
            detail: `${col.getType()} · ${ref.tableName}`,
            sortPriority: 7,
          });
        }
        if (cols.length > 0) {
          const list = cols.map((c) => c.getName()).join(',\n  ');
          push({
            label: `* all columns of ${ref.tableName}`,
            insertText: `  ${list}`,
            kind: 'columnList',
            detail: 'expand columns',
            sortPriority: 6,
          });
        }
      }
    }

    return out;
  } catch {
    return [];
  }
}

export { TableReference };

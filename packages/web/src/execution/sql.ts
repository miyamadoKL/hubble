// Pure SQL helpers for the execution layer (design.md §5 "セルと実行"):
//   - classifyStatement : coarse statement-kind detection (driven by the leading
//                         keyword, comment/whitespace stripped)
//   - statementHasLimit : detect a top-level LIMIT/FETCH so we never double it
//   - withAutoLimit     : append `LIMIT <n>` to a LIMIT-less row-returning query
//
// All three lean on the ANTLR lexer so that keywords inside string literals or
// comments never fool them (a bare `--` line or a `'limit'` string must not be
// mistaken for a clause). They are synchronous, throw-free, and exercised
// directly by vitest — no Monaco/DOM here.

import { CharStream, CommonTokenStream, Token } from 'antlr4ng';
import { SqlBaseLexer } from '../trino-lang/generated/SqlBaseLexer.js';

/**
 * Coarse statement kind. `select` covers every row-returning leading keyword
 * (SELECT / WITH / TABLE / VALUES / SHOW / DESCRIBE / EXPLAIN-less). `other`
 * is the safe bucket for DML/DDL/EXPLAIN where a LIMIT must never be appended.
 */
export type StatementKind =
  | 'select'
  | 'with'
  | 'explain'
  | 'insert'
  | 'show'
  | 'describe'
  | 'other'
  | 'empty';

// The grammar routes whitespace + line/block comments to channel(HIDDEN), so a
// single channel check drops all trivia. EOF is filtered separately.

/** All DEFAULT-channel, non-trivia tokens of `sql`, EOF excluded. */
function meaningfulTokens(sql: string): Token[] {
  const lexer = new SqlBaseLexer(CharStream.fromString(sql));
  lexer.removeErrorListeners();
  const stream = new CommonTokenStream(lexer);
  stream.fill();
  return stream
    .getTokens()
    .filter((t) => t.type !== Token.EOF && t.channel === Token.DEFAULT_CHANNEL);
}

/**
 * Classify a single statement by its leading keyword. Comments and whitespace
 * before the keyword are ignored. `WITH …` is reported as `with` (still
 * row-returning); `EXPLAIN …` as `explain` (never gets a LIMIT).
 */
export function classifyStatement(sql: string): StatementKind {
  const tokens = meaningfulTokens(sql);
  if (tokens.length === 0) return 'empty';
  const first = tokens[0]!;
  switch (first.type) {
    case SqlBaseLexer.SELECT:
      return 'select';
    case SqlBaseLexer.WITH:
      return 'with';
    case SqlBaseLexer.EXPLAIN:
      return 'explain';
    case SqlBaseLexer.INSERT:
      return 'insert';
    case SqlBaseLexer.SHOW:
      return 'show';
    case SqlBaseLexer.DESCRIBE:
    case SqlBaseLexer.DESC:
      return 'describe';
    case SqlBaseLexer.TABLE:
    case SqlBaseLexer.VALUES:
      // `TABLE t` / `VALUES (…)` are row-returning and accept LIMIT.
      return 'select';
    default:
      return 'other';
  }
}

/** True when the statement's leading keyword returns rows that we can cap. */
export function isRowReturning(kind: StatementKind): boolean {
  return kind === 'select' || kind === 'with';
}

/**
 * Detect a top-level LIMIT or FETCH FIRST clause. Uses the lexer so that the
 * word "limit" inside a string or comment, or a column named `limit`, never
 * counts. We only look for the LIMIT/FETCH *keyword tokens*; a column happens
 * to never lex as the LIMIT keyword (it is a reserved word in the grammar).
 */
export function statementHasLimit(sql: string): boolean {
  for (const token of meaningfulTokens(sql)) {
    if (token.type === SqlBaseLexer.LIMIT || token.type === SqlBaseLexer.FETCH) {
      return true;
    }
  }
  return false;
}

export interface AutoLimitResult {
  /** The statement, possibly with a trailing `LIMIT <n>`. */
  sql: string;
  /** True when a LIMIT clause was actually appended. */
  applied: boolean;
}

/**
 * Append `LIMIT <limit>` to a row-returning statement that has none. Anything
 * else (INSERT, EXPLAIN, SHOW, DESCRIBE, an already-LIMITed query, …) is
 * returned unchanged. A trailing semicolon (if the caller kept one) is
 * preserved after the inserted clause.
 */
export function withAutoLimit(sql: string, limit: number): AutoLimitResult {
  const kind = classifyStatement(sql);
  if (!isRowReturning(kind) || statementHasLimit(sql)) {
    return { sql, applied: false };
  }
  // Keep a trailing `;` (and any trailing whitespace) after the LIMIT.
  const match = /;(\s*)$/.exec(sql);
  if (match) {
    const head = sql.slice(0, match.index).trimEnd();
    return { sql: `${head}\nLIMIT ${limit};`, applied: true };
  }
  return { sql: `${sql.trimEnd()}\nLIMIT ${limit}`, applied: true };
}

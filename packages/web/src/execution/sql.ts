// Pure SQL helpers for the execution layer ("セルと実行"):
//   - classifyStatement : coarse statement-kind detection (driven by the leading
//                         keyword, comment/whitespace stripped)
//   - statementHasLimit : detect a top-level LIMIT/FETCH so we never double it
//   - withAutoLimit     : append `LIMIT <n>` to a LIMIT-less row-returning query
//
// All three lean on the ANTLR lexer so that keywords inside string literals or
// comments never fool them (a bare `--` line or a `'limit'` string must not be
// mistaken for a clause). They are synchronous, throw-free, and exercised
// directly by vitest — no Monaco/DOM here.
//
// ==== ファイルの責務（日本語） ================================================
// execution レイヤーが使う、純粋な SQL テキスト処理関数群。
//   - classifyStatement : 先頭キーワードによる大まかなステートメント種別判定
//                         （コメント/空白を無視した上で判定する）。
//   - statementHasLimit : トップレベルの LIMIT/FETCH 句の有無を検出し、
//                         auto-LIMIT の二重付与を防ぐ。
//   - withAutoLimit     : LIMIT の無い行返却系クエリへ `LIMIT <n>` を付与する。
// いずれも ANTLR の字句解析器（lexer）を利用しており、文字列リテラルや
// コメントの中にあるキーワードに惑わされない（`--` 行や `'limit'` という
// 文字列を誤って句として検出することがない）ようにしている。すべて
// 同期的で例外を投げない実装で、Monaco や DOM には依存せず vitest から
// 直接検証できる。
// ============================================================================

import { CharStream, CommonTokenStream, Token } from 'antlr4ng';
import { SqlBaseLexer } from '../trino-lang/generated/SqlBaseLexer.js';

/**
 * Coarse statement kind. `select` covers every row-returning leading keyword
 * (SELECT / WITH / TABLE / VALUES / SHOW / DESCRIBE / EXPLAIN-less). `other`
 * is the safe bucket for DML/DDL/EXPLAIN where a LIMIT must never be appended.
 *
 * 大まかなステートメント種別。`select` は行を返す先頭キーワードすべてを
 * まとめたもの（SELECT / WITH / TABLE / VALUES / SHOW / DESCRIBE）。
 * `other` は DML/DDL/EXPLAIN など、LIMIT を絶対に付与してはいけないものの
 * 安全側バケット。
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
// 文法定義上、空白と行/ブロックコメントは HIDDEN チャンネルに振り分けられる
// ため、チャンネルを 1 回チェックするだけで trivia（意味を持たないトークン）を
// すべて除外できる。EOF トークンは別途フィルタする。

/** All DEFAULT-channel, non-trivia tokens of `sql`, EOF excluded. */
/** `sql` の DEFAULT チャンネルかつ非 trivia なトークン一覧（EOF は除く）。 */
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
  // 先頭の意味あるトークンのみを見て種別を判定する（キーワード以外は無視）。
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
      // `TABLE t` / `VALUES (…)` も行を返すステートメントなので LIMIT を受け付ける。
      return 'select';
    default:
      return 'other';
  }
}

/** True when the statement's leading keyword returns rows that we can cap. */
/** 先頭キーワードが「LIMIT で件数を制限できる、行を返すクエリ」かどうか。 */
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
  // トークン列全体を走査し、LIMIT または FETCH キーワードのトークンが
  // 1 つでもあれば「既に LIMIT/FETCH 句がある」と判定する。
  for (const token of meaningfulTokens(sql)) {
    if (token.type === SqlBaseLexer.LIMIT || token.type === SqlBaseLexer.FETCH) {
      return true;
    }
  }
  return false;
}

export interface AutoLimitResult {
  /** The statement, possibly with a trailing `LIMIT <n>`. */
  /** LIMIT 句が末尾に付与された（かもしれない）ステートメントテキスト。 */
  sql: string;
  /** True when a LIMIT clause was actually appended. */
  /** 実際に LIMIT 句を付与した場合 true。 */
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
  // 行を返さない種別、または既に LIMIT/FETCH がある場合は何もしない。
  if (!isRowReturning(kind) || statementHasLimit(sql)) {
    return { sql, applied: false };
  }
  // Keep a trailing `;` (and any trailing whitespace) after the LIMIT.
  // 末尾にセミコロンがあれば、LIMIT 句を挿入したうえでセミコロンを保つ。
  const match = /;(\s*)$/.exec(sql);
  if (match) {
    const head = sql.slice(0, match.index).trimEnd();
    return { sql: `${head}\nLIMIT ${limit};`, applied: true };
  }
  // セミコロンが無ければ、末尾の空白を落として LIMIT 句を追加するだけ。
  return { sql: `${sql.trimEnd()}\nLIMIT ${limit}`, applied: true };
}

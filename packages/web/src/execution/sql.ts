// ==== ファイルの責務 ================================================
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

// 文法定義上、空白と行/ブロックコメントは HIDDEN チャンネルに振り分けられる
// ため、チャンネルを 1 回チェックするだけで trivia（意味を持たないトークン）を
// すべて除外できる。EOF トークンは別途フィルタする。

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
 * 単一ステートメントを先頭キーワードで分類する。キーワードより前にある
 * コメントと空白は無視する。`WITH …` は `with`（依然として行を返す）として、
 * `EXPLAIN …` は `explain`（LIMIT を付与されない）として報告する。
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
      // `TABLE t` / `VALUES (…)` も行を返すステートメントなので LIMIT を受け付ける。
      return 'select';
    default:
      return 'other';
  }
}

/** 先頭キーワードが「LIMIT で件数を制限できる、行を返すクエリ」かどうか。 */
export function isRowReturning(kind: StatementKind): boolean {
  return kind === 'select' || kind === 'with';
}

/**
 * トップレベルの LIMIT または FETCH FIRST 句を検出する。lexer を使うことで、
 * 文字列やコメント内の "limit" という単語や `limit` という名前の列を誤って
 * 検出しない。LIMIT/FETCH の *キーワードトークン* だけを見る（`limit` は文法上
 * 予約語のため、列名としてこのキーワードにはレックスされない）。
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
  /** LIMIT 句が末尾に付与された（かもしれない）ステートメントテキスト。 */
  sql: string;
  /** 実際に LIMIT 句を付与した場合 true。 */
  applied: boolean;
}

/**
 * LIMIT の無い行返却系ステートメントへ `LIMIT <limit>` を付与する。それ以外
 * （INSERT、EXPLAIN、SHOW、DESCRIBE、既に LIMIT があるクエリなど）はそのまま
 * 変更せず返す。呼び出し側が末尾にセミコロンを残していた場合は、挿入した
 * LIMIT 句の後ろにそのセミコロンを保つ。
 */
export function withAutoLimit(sql: string, limit: number): AutoLimitResult {
  const kind = classifyStatement(sql);
  // 行を返さない種別、または既に LIMIT/FETCH がある場合は何もしない。
  if (!isRowReturning(kind) || statementHasLimit(sql)) {
    return { sql, applied: false };
  }
  // 末尾にセミコロンがあれば、LIMIT 句を挿入したうえでセミコロンを保つ。
  const match = /;(\s*)$/.exec(sql);
  if (match) {
    const head = sql.slice(0, match.index).trimEnd();
    return { sql: `${head}\nLIMIT ${limit};`, applied: true };
  }
  // セミコロンが無ければ、末尾の空白を落として LIMIT 句を追加するだけ。
  return { sql: `${sql.trimEnd()}\nLIMIT ${limit}`, applied: true };
}

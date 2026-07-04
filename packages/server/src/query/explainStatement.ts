/**
 * EXPLAIN 文の解析。ANALYZE 付きのとき内側ステートメントを取り出す。
 */

/** EXPLAIN 文の解析結果。 */
export interface ExplainParseResult {
  /** ANALYZE（または INCLUDE ANALYZE）が指定されているか。 */
  hasAnalyze: boolean;
  /** EXPLAIN ラッパーを除いた内側の SQL。 */
  inner: string;
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
}

/** 位置 i から空白とコメントを読み飛ばし、次の有意文字の位置を返す。 */
function skipTrivia(sql: string, i: number): number {
  while (i < sql.length) {
    if (isWhitespace(sql[i]!)) {
      i += 1;
      continue;
    }
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

/** クォート区切りを読み進め、閉じクォート直後の位置を返す。 */
function scanQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

/** 位置 start の '(' に対応する ')' の直後位置を返す。見つからなければ -1。 */
function findMatchingParen(sql: string, start: number): number {
  if (sql[start] !== '(') return -1;
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (isWhitespace(ch)) {
      i += 1;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length - 1 && !(sql[i] === '*' && sql[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      i = scanQuoted(sql, i, "'");
      continue;
    }
    if (ch === '"') {
      i = scanQuoted(sql, i, '"');
      continue;
    }
    if (ch === '`') {
      i = scanQuoted(sql, i, '`');
      continue;
    }
    if (ch === '(') {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      i += 1;
      if (depth === 0) return i;
      continue;
    }
    i += 1;
  }
  return -1;
}

/** 先頭が keyword かどうか（大文字小文字無視）。 */
function startsWithKeyword(sql: string, pos: number, keyword: string): boolean {
  const slice = sql.slice(pos);
  const re = new RegExp(`^${keyword}\\b`, 'i');
  const match = re.exec(slice);
  return match !== null;
}

/** 括弧内オプションに ANALYZE が含まれるか（INCLUDE ANALYZE または単独 ANALYZE）。 */
function optionsIncludeAnalyze(options: string): boolean {
  const upper = options.toUpperCase();
  return /\bINCLUDE\s+ANALYZE\b/.test(upper) || /\bANALYZE\b/.test(upper);
}

/**
 * EXPLAIN 文を解析する。EXPLAIN でなければ null。
 * ANALYZE 付きのときだけ内側ステートメントを取り出す。
 */
export function parseExplainStatement(statement: string): ExplainParseResult | null {
  const sql = statement.trim();
  if (!startsWithKeyword(sql, 0, 'EXPLAIN')) return null;

  let i = skipTrivia(sql, 'EXPLAIN'.length);
  let hasAnalyze = false;

  if (sql[i] === '(') {
    const end = findMatchingParen(sql, i);
    if (end < 0) {
      return { hasAnalyze: false, inner: sql.slice(i).trim() };
    }
    hasAnalyze = optionsIncludeAnalyze(sql.slice(i + 1, end - 1));
    i = skipTrivia(sql, end);
  }

  if (!hasAnalyze && startsWithKeyword(sql, i, 'ANALYZE')) {
    hasAnalyze = true;
    i = skipTrivia(sql, i + 'ANALYZE'.length);
    if (startsWithKeyword(sql, i, 'VERBOSE')) {
      i = skipTrivia(sql, i + 'VERBOSE'.length);
    }
  }

  return { hasAnalyze, inner: sql.slice(i).trim() };
}

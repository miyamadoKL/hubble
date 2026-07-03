/**
 * query.write 権限の第 1 層チェック（キーワード高速パス + Trino IO explain）。
 */
import { WRITE_NOT_ALLOWED } from '@hubble/contracts';
import { AppError } from '../errors';
import { classifyIoPlanWrites } from '../query/explainIo';
import { fetchTrinoIoExplainCell } from '../engine/trinoEstimate';
import type { StatementClient } from '../engine/types';
import type { TrinoRequestContext } from '../trino/types';
import { hasQueryWrite } from './check';
import type { ResolvedRole } from './types';

const WRITE_PREFIX_KEYWORDS = new Set([
  'INSERT',
  'UPDATE',
  'DELETE',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'MERGE',
  'CALL',
  'GRANT',
]);

const READ_FAST_KEYWORDS = new Set(['SELECT', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'USE']);

/** ステートメント先頭の書き込み意図分類。 */
export type StatementWriteClassification = 'allow' | 'deny' | 'explain';

const UNCLASSIFIED_MESSAGE =
  '読み取り専用ロールのため実行できません。分類できない文は管理者に相談してください。';

const WRITE_DENIED_MESSAGE = '読み取り専用ロールのため書き込み文は実行できません。';

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
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

/** 位置 start 以降が空白とコメントだけかどうか。 */
function isOnlyTrailingTrivia(sql: string, start: number): boolean {
  let i = start;
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
    return false;
  }
  return true;
}

/**
 * 文字列リテラル・クォート識別子・コメントを考慮し、
 * 文末以外のセミコロン（複数文）があるか判定する。
 */
function containsMultipleStatements(statement: string): boolean {
  const sql = statement;
  let i = 0;
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
    if (ch === ';') {
      return !isOnlyTrailingTrivia(sql, i + 1);
    }
    i += 1;
  }
  return false;
}

/** SQL コメントを除いた先頭トークン列を返す。 */
function significantTokens(statement: string): string[] {
  let sql = statement.trim();
  const tokens: string[] = [];
  for (;;) {
    if (sql.startsWith('--')) {
      const end = sql.indexOf('\n');
      sql = end < 0 ? '' : sql.slice(end + 1).trimStart();
      continue;
    }
    if (sql.startsWith('/*')) {
      const end = sql.indexOf('*/');
      sql = end < 0 ? '' : sql.slice(end + 2).trimStart();
      continue;
    }
    const match = /^("([^"]|"")*"|\S+)/.exec(sql);
    if (!match) break;
    tokens.push(match[1]!.replace(/^"(.*)"$/, '$1').toUpperCase());
    sql = sql.slice(match[0].length).trimStart();
    if (tokens.length >= 3) break;
  }
  return tokens;
}

/**
 * 先頭キーワードから書き込み意図を分類する。
 * WITH や曖昧な文は IO explain へ回す。
 */
export function classifyStatementWrite(statement: string): StatementWriteClassification {
  if (containsMultipleStatements(statement)) return 'explain';

  const tokens = significantTokens(statement);
  if (tokens.length === 0) return 'explain';

  const first = tokens[0]!;
  if (WRITE_PREFIX_KEYWORDS.has(first)) return 'deny';

  if (first === 'SET' && tokens[1] === 'SESSION') return 'allow';
  if (READ_FAST_KEYWORDS.has(first)) return 'allow';

  return 'explain';
}

function writeNotAllowed(message: string): AppError {
  return AppError.forbidden(message, WRITE_NOT_ALLOWED);
}

export interface AssertQueryWriteParams {
  statement: string;
  role: ResolvedRole;
  /** Trino の IO explain 実行に使うクライアント（Trino のみ必須）。 */
  ioExplainClient?: StatementClient;
  ioExplainCtx?: TrinoRequestContext;
  ioExplainTimeoutMs?: number;
}

/**
 * query.write を持たない principal の実行を拒否する。
 * 持つ場合は何もしない。
 */
export async function assertQueryWriteAllowed(params: AssertQueryWriteParams): Promise<void> {
  if (hasQueryWrite(params.role)) return;

  const classification = classifyStatementWrite(params.statement);
  if (classification === 'allow') return;
  if (classification === 'deny') throw writeNotAllowed(WRITE_DENIED_MESSAGE);

  if (params.ioExplainClient === undefined || params.ioExplainCtx === undefined) {
    throw writeNotAllowed(UNCLASSIFIED_MESSAGE);
  }

  const timeoutMs = params.ioExplainTimeoutMs ?? 30_000;
  let cell: string | undefined;
  try {
    cell = await fetchTrinoIoExplainCell(
      params.statement,
      params.ioExplainCtx,
      params.ioExplainClient,
      timeoutMs,
    );
  } catch {
    throw writeNotAllowed(UNCLASSIFIED_MESSAGE);
  }

  if (cell === undefined) {
    throw writeNotAllowed(UNCLASSIFIED_MESSAGE);
  }

  const writes = classifyIoPlanWrites(cell);
  if (writes === true) throw writeNotAllowed(WRITE_DENIED_MESSAGE);
  if (writes === 'unclassified') throw writeNotAllowed(UNCLASSIFIED_MESSAGE);
}

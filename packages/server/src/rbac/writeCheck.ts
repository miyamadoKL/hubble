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

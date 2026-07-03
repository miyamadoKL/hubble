/**
 * ドライバエラーを Trino 互換の例外へマッピングする。
 *
 * retry.ts の classifyFailure は TrinoQueryError の errorType === 'USER_ERROR' を
 * deterministic、TrinoTransportError を transient と分類する。MySQL/PostgreSQL も
 * 同じ契約に合わせる。
 */
import { TrinoQueryError, TrinoTransportError, trinoError } from '../../errors';
import type { TrinoError } from '../../trino/types';

/** PostgreSQL の構文エラーコード。 */
const PG_SYNTAX_ERROR = '42601';

/** MySQL の構文/解析系 errno。 */
const MYSQL_SYNTAX_ERRNOS = new Set([1064, 1149, 1060, 1054]);

/** MySQL の一時障害 errno(リトライ対象。USER_ERROR bucket より先に判定する)。 */
const MYSQL_TRANSIENT_ERRNOS = new Set([
  1040, // ER_CON_COUNT_ERROR: Too many connections
  1041, // ER_OUT_OF_MEMORY
  1053, // ER_SERVER_SHUTDOWN: Server shutdown in progress
  1203, // ER_TOO_MANY_USER_CONNECTIONS
  1159, // ER_NET_READ_INTERRUPTED
  1160, // ER_NET_WRITE_INTERRUPTED
  2006, // ER_SERVER_GONE_ERROR
  2013, // ER_SERVER_LOST
]);

const CONNECTION_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EHOSTUNREACH',
]);

const PG_CONNECTION_CODES = new Set([
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '57P01',
  '57P02',
  '57P03',
]);

function isConnectionCode(code: string | undefined): boolean {
  if (!code) return false;
  if (CONNECTION_ERRNO.has(code)) return true;
  return PG_CONNECTION_CODES.has(code);
}

/** MySQL の "at line N" から行番号を抽出する。 */
export function parseMysqlLine(message: string): number | undefined {
  const m = /at line (\d+)/i.exec(message);
  if (!m) return undefined;
  const line = Number.parseInt(m[1]!, 10);
  return line > 0 ? line : undefined;
}

/** PostgreSQL の position(文字オフセット)から行番号を概算する。 */
export function pgPositionToLine(statement: string, position: number | undefined): number | undefined {
  if (position === undefined || position <= 0) return undefined;
  const prefix = statement.slice(0, position - 1);
  const line = prefix.split('\n').length;
  return line > 0 ? line : undefined;
}

function throwTrinoQuery(err: TrinoError): never {
  throw trinoError(err);
}

function throwTransport(message: string): never {
  throw new TrinoTransportError(message);
}

/**
 * mysql2 の QueryError を Trino 互換例外へ変換する。
 * @param err - mysql2 が投げたエラー。
 */
export function throwMysqlDriverError(err: unknown): never {
  const e = err as { code?: string; errno?: number; message?: string; sqlMessage?: string };
  const message = e.sqlMessage ?? e.message ?? 'MySQL query failed';
  if (isConnectionCode(e.code)) {
    throwTransport(`MySQL connection failed: ${message}`);
  }
  if (e.errno !== undefined && MYSQL_SYNTAX_ERRNOS.has(e.errno)) {
    const line = parseMysqlLine(message);
    throwTrinoQuery({
      message,
      errorType: 'USER_ERROR',
      errorName: 'SYNTAX_ERROR',
      errorLocation: line !== undefined ? { lineNumber: line, columnNumber: 1 } : undefined,
    });
  }
  if (e.errno !== undefined && MYSQL_TRANSIENT_ERRNOS.has(e.errno)) {
    throwTransport(`MySQL transient failure: ${message}`);
  }
  // 実行時のユーザー起因エラー(未知テーブル等)も USER_ERROR 扱い。
  if (e.errno !== undefined && e.errno >= 1000 && e.errno < 2000) {
    const line = parseMysqlLine(message);
    throwTrinoQuery({
      message,
      errorType: 'USER_ERROR',
      errorName: 'USER_ERROR',
      errorLocation: line !== undefined ? { lineNumber: line, columnNumber: 1 } : undefined,
    });
  }
  // システム起因は USER_ERROR 以外(リトライ対象)。
  throwTrinoQuery({
    message,
    errorType: 'INTERNAL_ERROR',
    errorName: 'INTERNAL_ERROR',
  });
}

/**
 * pg の DatabaseError を Trino 互換例外へ変換する。
 * @param err - node-postgres が投げたエラー。
 * @param statement - 行番号計算用の SQL 原文(省略可)。
 */
export function throwPgDriverError(err: unknown, statement?: string): never {
  const e = err as { code?: string; message?: string; position?: string };
  const message = e.message ?? 'PostgreSQL query failed';
  if (isConnectionCode(e.code)) {
    throwTransport(`PostgreSQL connection failed: ${message}`);
  }
  if (e.code === PG_SYNTAX_ERROR) {
    const pos = e.position !== undefined ? Number.parseInt(e.position, 10) : undefined;
    const line = statement !== undefined ? pgPositionToLine(statement, pos) : undefined;
    throwTrinoQuery({
      message,
      errorType: 'USER_ERROR',
      errorName: 'SYNTAX_ERROR',
      errorLocation: line !== undefined ? { lineNumber: line, columnNumber: 1 } : undefined,
    });
  }
  // SQLSTATE class 42* はユーザー起因のエラー。
  if (e.code?.startsWith('42')) {
    const pos = e.position !== undefined ? Number.parseInt(e.position, 10) : undefined;
    const line = statement !== undefined ? pgPositionToLine(statement, pos) : undefined;
    throwTrinoQuery({
      message,
      errorType: 'USER_ERROR',
      errorName: e.code,
      errorLocation: line !== undefined ? { lineNumber: line, columnNumber: 1 } : undefined,
    });
  }
  throwTrinoQuery({
    message,
    errorType: 'INTERNAL_ERROR',
    errorName: e.code ?? 'INTERNAL_ERROR',
  });
}

/** 接続断かどうかを判定する(validate の unavailable 用)。 */
export function isConnectionFailure(err: unknown): boolean {
  if (err instanceof TrinoTransportError) return true;
  const e = err as { code?: string };
  return isConnectionCode(e.code);
}

/** 構文エラーかどうかを判定する(validate の user_error 用)。 */
export function isSyntaxFailure(err: unknown, driver: 'mysql' | 'postgresql'): boolean {
  if (err instanceof TrinoQueryError && err.trino.errorType === 'USER_ERROR') {
    const name = err.trino.errorName ?? '';
    if (driver === 'postgresql') return name === 'SYNTAX_ERROR' || err.trino.errorName === '42601';
    return name === 'SYNTAX_ERROR' || name === 'USER_ERROR';
  }
  const e = err as { code?: string; errno?: number };
  if (driver === 'postgresql') return e.code === PG_SYNTAX_ERROR;
  return e.errno !== undefined && MYSQL_SYNTAX_ERRNOS.has(e.errno);
}

/** TrinoQueryError から ValidationResult 用の user_error を組み立てる。 */
export function trinoErrorToValidation(err: TrinoQueryError): {
  ok: false;
  kind: 'user_error';
  message: string;
  line?: number;
  column?: number;
} {
  const loc = err.trino.errorLocation;
  return {
    ok: false,
    kind: 'user_error',
    message: err.trino.message,
    line: loc?.lineNumber,
    column: loc?.columnNumber,
  };
}
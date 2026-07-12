/**
 * ドライバエラーを Trino 互換の例外へマッピングする。
 *
 * SQL ドライバ固有コードから HTTP 上の責任区分と再試行可否を別々に決める。
 * `SqlDriverError` はその二つを保持し、呼び出し側が片方から他方を推測しないようにする。
 */
import {
  SqlDriverError,
  TrinoQueryError,
  TrinoTransportError,
  type SqlDriverRetryClass,
} from '../../errors';
import type { TrinoError } from '../../trino/types';

/** PostgreSQL の構文エラーコード。 */
const PG_SYNTAX_ERROR = '42601';

/** MySQL の構文または解析エラー errno。 */
const MYSQL_SYNTAX_ERRNOS = new Set([1054, 1060, 1064, 1149]);

/** MySQL の入力、名前解決、制約違反など、同じ SQL では解消しない errno。 */
const MYSQL_DETERMINISTIC_ERRNOS = new Set([
  1048, // ER_BAD_NULL_ERROR: NULL 制約違反
  1050, // ER_TABLE_EXISTS_ERROR: 既存テーブルとの重複
  1051, // ER_BAD_TABLE_ERROR: 未知のテーブル
  1052, // ER_NON_UNIQ_ERROR: 曖昧なカラム
  1054, // ER_BAD_FIELD_ERROR: 未知のカラム
  1060, // ER_DUP_FIELDNAME: カラム名重複
  1062, // ER_DUP_ENTRY: 一意制約違反
  1091, // ER_CANT_DROP_FIELD_OR_KEY: 未知の削除対象
  1136, // ER_WRONG_VALUE_COUNT_ON_ROW: 値の個数不一致
  1146, // ER_NO_SUCH_TABLE: 未知のテーブル
  1172, // ER_TOO_MANY_ROWS: 行数不一致
  1235, // ER_NOT_SUPPORTED_YET: 未対応機能
  1241, // ER_OPERAND_COLUMNS: オペランド列数不一致
  1242, // ER_SUBQUERY_NO_1_ROW: スカラー副問い合わせの複数行
  1318, // ER_SP_WRONG_NO_OF_ARGS: 引数個数不一致
  1364, // ER_NO_DEFAULT_FOR_FIELD: 既定値なし
  1366, // ER_TRUNCATED_WRONG_VALUE_FOR_FIELD: 値形式不正
  1406, // ER_DATA_TOO_LONG: データ長超過
  1451, // ER_ROW_IS_REFERENCED_2: 外部キー制約違反
  1452, // ER_NO_REFERENCED_ROW_2: 外部キー参照先なし
  1582, // ER_WRONG_PARAMCOUNT_TO_NATIVE_FCT: 関数引数個数不一致
  1690, // ER_DATA_OUT_OF_RANGE: 値範囲超過
  3819, // ER_CHECK_CONSTRAINT_VIOLATED: CHECK 制約違反
]);

/** MySQL の一時障害 errno(リトライ対象。USER_ERROR bucket より先に判定する)。 */
const MYSQL_TRANSIENT_ERRNOS = new Set([
  1021, // ER_DISK_FULL: ディスク容量不足
  1037, // ER_OUT_OF_MEMORY: メモリ不足
  1038, // ER_OUT_OF_SORTMEMORY: ソート用メモリ不足
  1040, // ER_CON_COUNT_ERROR: Too many connections
  1041, // ER_OUT_OF_MEMORY
  1053, // ER_SERVER_SHUTDOWN: Server shutdown in progress
  1203, // ER_TOO_MANY_USER_CONNECTIONS
  1205, // ER_LOCK_WAIT_TIMEOUT: ロック待機期限切れ
  1213, // ER_LOCK_DEADLOCK: デッドロック
  1159, // ER_NET_READ_INTERRUPTED
  1160, // ER_NET_WRITE_INTERRUPTED
  1161, // ER_NET_WRITE_ERROR: ネットワーク書き込み失敗
  1614, // ER_XA_RBDEADLOCK: XA トランザクションのデッドロック
  2006, // ER_SERVER_GONE_ERROR
  2013, // ER_SERVER_LOST
  2055, // CR_SERVER_LOST_EXTENDED: サーバー接続喪失
]);

/** PostgreSQL の再実行しても同じ結果になる SQLSTATE class。 */
const PG_DETERMINISTIC_CLASSES = new Set([
  '0A', // 未対応機能
  '22', // データ例外
  '23', // 整合性制約違反
  '2B', // 依存権限記述子あり
  '2D', // トランザクション終端不正
  '3D', // カタログ名不正
  '3F', // スキーマ名不正
  '42', // 構文またはアクセス規則違反
  '54', // ステートメント複雑度などのプログラム上限超過
]);

/** statement を変えても解消せず、利用者入力の HTTP 400 にもできない SQLSTATE class。 */
const PG_DETERMINISTIC_INFRASTRUCTURE_CLASSES = new Set([
  '28', // 認証指定不正
]);

/** PostgreSQL の再実行で解消しうる SQLSTATE class。 */
const PG_TRANSIENT_CLASSES = new Set([
  '08', // 接続例外
  '40', // トランザクションロールバック
  '53', // リソース不足
  '55', // 前提状態不成立またはロック競合
  '57', // オペレーター介入
  '58', // システムエラー
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
export function pgPositionToLine(
  statement: string,
  position: number | undefined,
): number | undefined {
  if (position === undefined || position <= 0) return undefined;
  const prefix = statement.slice(0, position - 1);
  const line = prefix.split('\n').length;
  return line > 0 ? line : undefined;
}

function throwDriverQuery(err: TrinoError, retryClass: SqlDriverRetryClass): never {
  throw new SqlDriverError(err, retryClass);
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
    throwDriverQuery(
      {
        message,
        errorType: 'USER_ERROR',
        errorName: 'SYNTAX_ERROR',
        errorLocation: line !== undefined ? { lineNumber: line, columnNumber: 1 } : undefined,
      },
      'deterministic',
    );
  }
  if (e.errno !== undefined && MYSQL_TRANSIENT_ERRNOS.has(e.errno)) {
    throwTransport(`MySQL transient failure: ${message}`);
  }
  if (e.errno !== undefined && MYSQL_DETERMINISTIC_ERRNOS.has(e.errno)) {
    const line = parseMysqlLine(message);
    throwDriverQuery(
      {
        message,
        errorType: 'USER_ERROR',
        errorName: 'USER_ERROR',
        errorLocation: line !== undefined ? { lineNumber: line, columnNumber: 1 } : undefined,
      },
      'deterministic',
    );
  }
  // システム起因は USER_ERROR 以外(リトライ対象)。
  throwDriverQuery(
    {
      message,
      errorType: 'INTERNAL_ERROR',
      errorName: 'INTERNAL_ERROR',
    },
    'transient',
  );
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
    throwDriverQuery(
      {
        message,
        errorType: 'USER_ERROR',
        errorName: 'SYNTAX_ERROR',
        errorLocation: line !== undefined ? { lineNumber: line, columnNumber: 1 } : undefined,
      },
      'deterministic',
    );
  }
  const sqlStateClass = e.code?.slice(0, 2);
  if (sqlStateClass && PG_DETERMINISTIC_CLASSES.has(sqlStateClass)) {
    const pos = e.position !== undefined ? Number.parseInt(e.position, 10) : undefined;
    const line = statement !== undefined ? pgPositionToLine(statement, pos) : undefined;
    throwDriverQuery(
      {
        message,
        errorType: 'USER_ERROR',
        errorName: e.code,
        errorLocation: line !== undefined ? { lineNumber: line, columnNumber: 1 } : undefined,
      },
      'deterministic',
    );
  }
  if (sqlStateClass && PG_DETERMINISTIC_INFRASTRUCTURE_CLASSES.has(sqlStateClass)) {
    throwDriverQuery(
      {
        message,
        errorType: 'EXTERNAL_ERROR',
        errorName: e.code,
      },
      'deterministic',
    );
  }
  if (sqlStateClass && PG_TRANSIENT_CLASSES.has(sqlStateClass)) {
    throwTransport(`PostgreSQL transient failure: ${message}`);
  }
  throwDriverQuery(
    {
      message,
      errorType: 'INTERNAL_ERROR',
      errorName: e.code ?? 'INTERNAL_ERROR',
    },
    'transient',
  );
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

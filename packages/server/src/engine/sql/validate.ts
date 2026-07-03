/**
 * EXPLAIN による permissive なスケジュール事前検証。
 */
import { TrinoQueryError } from '../../errors';
import type { ValidationResult } from '../../schedule/validator';
import {
  isConnectionFailure,
  isSyntaxFailure,
  throwMysqlDriverError,
  throwPgDriverError,
  trinoErrorToValidation,
} from './errors';

/**
 * EXPLAIN を実行し、構文エラーのみ user_error、それ以外の SQL エラーは ok:true とする。
 * @param runExplain - EXPLAIN 実行関数。
 * @param statement - 検証対象 SQL。
 * @param driver - mysql または postgresql。
 */
export async function validateWithExplain(
  runExplain: (sql: string) => Promise<void>,
  statement: string,
  driver: 'mysql' | 'postgresql',
): Promise<ValidationResult> {
  try {
    await runExplain(`EXPLAIN ${statement}`);
    return { ok: true };
  } catch (err) {
    if (isConnectionFailure(err)) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: 'unavailable', message };
    }
    if (err instanceof TrinoQueryError) {
      if (isSyntaxFailure(err, driver)) {
        return trinoErrorToValidation(err);
      }
      return { ok: true };
    }
    if (isSyntaxFailure(err, driver)) {
      try {
        if (driver === 'mysql') throwMysqlDriverError(err);
        else throwPgDriverError(err, statement);
      } catch (mapped) {
        if (mapped instanceof TrinoQueryError && isSyntaxFailure(mapped, driver)) {
          return trinoErrorToValidation(mapped);
        }
        throw mapped;
      }
    }
    // EXPLAIN 非対応などは実行時に判明させる。
    return { ok: true };
  }
}

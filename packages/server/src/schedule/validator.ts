import { TrinoQueryError } from '../errors';
import type { TrinoClient } from '../trino/client';
import { runToCompletion } from '../trino/runner';
import type { TrinoRequestContext } from '../trino/types';

/**
 * このファイルは Query Scheduling 機能の事前検証 (pre-run validation) を担う
 * `StatementValidator` を提供する。schedule の作成/更新時 (store/schedules 経由の
 * ルートハンドラ) と、実際の発火直前 (scheduler.ts の attemptWithRetries) の
 * 両方で呼び出される。実 SQL を実行せず `EXPLAIN (TYPE VALIDATE)` のみを投げることで、
 * 構文/意味エラーを安価かつ高速に検出する。
 */

/** Outcome of an `EXPLAIN (TYPE VALIDATE)` check. */
// 日本語: 検証結果を表す判別可能ユニオン。ok=true は検証成功、ok=false は
// kind によって「SQL が悪い (user_error)」か「検証自体が実行できなかった
// (unavailable)」かに分かれる。
export type ValidationResult =
  | { ok: true }
  /** Deterministic statement fault (USER_ERROR): line/column + message. */
  | { ok: false; kind: 'user_error'; message: string; line?: number; column?: number }
  /**
   * The validation itself could not run (Trino unreachable, transport fault).
   * The caller decides whether to allow (create-time: lenient) or fail
   * (run-time: treated as a transient failure).
   */
  // 日本語: 呼び出し元 (作成時 API か scheduler.ts の実行時か) が unavailable の
  // 扱いを決める。作成時はゆるく許可 (Trino が一時的に落ちていても登録は通す)、
  // 実行時は retry.ts 相当の transient 失敗として扱いリトライ対象にする。
  | { ok: false; kind: 'unavailable'; message: string };

export interface ValidateParams {
  statement: string;
  catalog?: string | null;
  schema?: string | null;
  /** `X-Trino-User` the validation runs as (the schedule owner). */
  principal: string;
}

/**
 * Validate a statement with Trino's `EXPLAIN (TYPE VALIDATE) <stmt>` (Query
 * Scheduling feature). This runs only on the coordinator and is fast: it
 * returns a single `[[true]]` cell on success, and a `USER_ERROR` with a
 * line/column-tagged message on a syntax/semantic error.
 *
 * A `USER_ERROR` is reported as a deterministic `user_error`; any other failure
 * (transport, engine fault) is reported as `unavailable` so the caller can be
 * lenient at create time and treat it as transient at run time.
 */
export class StatementValidator {
  constructor(
    private readonly client: TrinoClient,
    /** `X-Trino-Source` tag for validation EXPLAINs. */
    private readonly source: string,
  ) {}

  async validate(params: ValidateParams): Promise<ValidationResult> {
    const ctx: TrinoRequestContext = {
      catalog: params.catalog ?? undefined,
      schema: params.schema ?? undefined,
      source: this.source,
      // 日本語: 検証は schedule の所有者 (principal) として実行する。実際の実行時と
      // 同じ権限で検証することで、権限起因のエラーも事前に検出できる。
      user: params.principal,
    };
    try {
      // 日本語: コーディネータのみで完結する軽量な EXPLAIN VALIDATE。成功すれば
      // 結果行 [[true]] を読み捨てて ok:true を返す (runToCompletion は完走まで待つ)。
      await runToCompletion(this.client, `EXPLAIN (TYPE VALIDATE) ${params.statement}`, ctx);
      return { ok: true };
    } catch (err) {
      if (err instanceof TrinoQueryError && err.trino.errorType === 'USER_ERROR') {
        // 日本語: SQL の構文/意味エラー。可能なら行/列番号も添えて返す
        // (0 以下は「位置情報なし」として無視する)。
        const loc = err.trino.errorLocation;
        const result: ValidationResult = {
          ok: false,
          kind: 'user_error',
          message: err.trino.message,
        };
        if (loc?.lineNumber && loc.lineNumber > 0) result.line = loc.lineNumber;
        if (loc?.columnNumber && loc.columnNumber > 0) result.column = loc.columnNumber;
        return result;
      }
      // 日本語: USER_ERROR 以外 (接続不可、タイムアウト、エンジン内部エラー等) は
      // 検証そのものが行えなかったとみなし unavailable として返す。
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: 'unavailable', message };
    }
  }
}

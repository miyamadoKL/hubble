import { TrinoQueryError } from '../errors';
import type { TrinoClient } from '../trino/client';
import { runToCompletion } from '../trino/runner';
import type { TrinoRequestContext } from '../trino/types';

/** Outcome of an `EXPLAIN (TYPE VALIDATE)` check. */
export type ValidationResult =
  | { ok: true }
  /** Deterministic statement fault (USER_ERROR): line/column + message. */
  | { ok: false; kind: 'user_error'; message: string; line?: number; column?: number }
  /**
   * The validation itself could not run (Trino unreachable, transport fault).
   * The caller decides whether to allow (create-time: lenient) or fail
   * (run-time: treated as a transient failure).
   */
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
      user: params.principal,
    };
    try {
      await runToCompletion(this.client, `EXPLAIN (TYPE VALIDATE) ${params.statement}`, ctx);
      return { ok: true };
    } catch (err) {
      if (err instanceof TrinoQueryError && err.trino.errorType === 'USER_ERROR') {
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
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, kind: 'unavailable', message };
    }
  }
}

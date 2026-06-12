import type { ApiErrorDetail } from '@hubble/contracts';
import type { TrinoError } from './trino/types';

/**
 * An application error carrying a contract `ApiErrorDetail` and an HTTP status.
 * Thrown throughout the server and rendered uniformly by the error handler in
 * `app.ts` as the `{ error: { ... } }` envelope (design.md §7).
 */
export class AppError extends Error {
  readonly status: number;
  readonly detail: ApiErrorDetail;

  constructor(status: number, detail: ApiErrorDetail) {
    super(detail.message);
    this.name = 'AppError';
    this.status = status;
    this.detail = detail;
  }

  static notFound(message: string): AppError {
    return new AppError(404, { code: 'NOT_FOUND', message });
  }

  static badRequest(message: string, code = 'BAD_REQUEST'): AppError {
    return new AppError(400, { code, message });
  }

  static conflict(message: string): AppError {
    return new AppError(409, { code: 'CONFLICT', message });
  }

  static internal(message: string): AppError {
    return new AppError(500, { code: 'INTERNAL', message });
  }

  /**
   * Query Guard block (Query Guard feature): an estimate exceeded the configured
   * limits in `enforce` mode. Surfaced as HTTP 422 with the `QUERY_BLOCKED` code;
   * `details` carries the `EstimateResult` and the active limits for the UI.
   */
  static queryBlocked(message: string, details: Record<string, unknown>): AppError {
    return new AppError(422, { code: 'QUERY_BLOCKED', message, details });
  }
}

/** Convert a Trino error payload into a contract `ApiErrorDetail`. */
export function trinoErrorToDetail(error: TrinoError): ApiErrorDetail {
  const detail: ApiErrorDetail = {
    code: 'TRINO_ERROR',
    message: error.message || 'Trino query failed',
  };
  if (error.errorName) detail.trinoErrorName = error.errorName;
  const loc = error.errorLocation;
  if (loc) {
    if (typeof loc.lineNumber === 'number' && loc.lineNumber > 0) detail.line = loc.lineNumber;
    if (typeof loc.columnNumber === 'number' && loc.columnNumber > 0) {
      detail.column = loc.columnNumber;
    }
  }
  return detail;
}

/**
 * An `AppError` (HTTP 400 — user/query fault) that also retains the raw Trino
 * error so callers that need the `errorType` (e.g. Query Guard, to tell a
 * USER_ERROR apart from an engine fault) can inspect it.
 */
export class TrinoQueryError extends AppError {
  readonly trino: TrinoError;
  constructor(error: TrinoError) {
    super(400, trinoErrorToDetail(error));
    this.name = 'TrinoQueryError';
    this.trino = error;
  }
}

/** Build an `AppError` from a Trino error payload (HTTP 400 — user/query fault). */
export function trinoError(error: TrinoError): AppError {
  return new TrinoQueryError(error);
}

/**
 * A transport-level failure talking to Trino (network error, non-2xx that is
 * not a structured Trino error). Surfaced as 502 Bad Gateway.
 */
export class TrinoTransportError extends AppError {
  constructor(message: string) {
    super(502, { code: 'TRINO_UNAVAILABLE', message });
    this.name = 'TrinoTransportError';
  }
}

/** Normalize any thrown value into an `ApiErrorDetail` + status. */
export function toErrorResponse(err: unknown): { status: number; detail: ApiErrorDetail } {
  if (err instanceof AppError) {
    return { status: err.status, detail: err.detail };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: 500, detail: { code: 'INTERNAL', message } };
}

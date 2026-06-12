import {
  apiErrorSchema,
  appConfigSchema,
  apiRoutes,
  meResponseSchema,
  type ApiErrorDetail,
  type AppConfig,
  type MeResponse,
} from '@hue-fable/contracts';
import type { ZodType } from 'zod';

/**
 * Error thrown by the API client. Carries the parsed `{ error }` envelope
 * (design.md §7) when the server returns one, plus the HTTP status.
 */
export class ApiClientError extends Error {
  readonly status: number;
  readonly detail: ApiErrorDetail;

  constructor(status: number, detail: ApiErrorDetail) {
    super(detail.message);
    this.name = 'ApiClientError';
    this.status = status;
    this.detail = detail;
  }
}

async function parseErrorBody(res: Response): Promise<ApiErrorDetail> {
  try {
    const json = await res.json();
    const parsed = apiErrorSchema.safeParse(json);
    if (parsed.success) return parsed.data.error;
  } catch {
    // fall through to a synthetic error below
  }
  return {
    code: 'HTTP_ERROR',
    message: `Request failed with status ${res.status}`,
  };
}

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  /** Query-string parameters appended to the path. */
  query?: Record<string, string | number | boolean | undefined>;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

/**
 * Typed fetch wrapper. Validates the response against `schema` (a zod schema
 * from @hue-fable/contracts) and throws `ApiClientError` on non-2xx responses
 * or schema mismatches.
 */
export async function apiFetch<T>(
  schema: ZodType<T>,
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const { body, query, headers, ...rest } = options;
  const init: RequestInit = { ...rest, headers: { ...headers } };

  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json', ...init.headers };
    init.body = JSON.stringify(body);
  }

  const res = await fetch(buildUrl(path, query), init);

  if (!res.ok) {
    throw new ApiClientError(res.status, await parseErrorBody(res));
  }

  const json = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiClientError(res.status, {
      code: 'INVALID_RESPONSE',
      message: `Response did not match the expected schema: ${parsed.error.message}`,
    });
  }
  return parsed.data;
}

/** Fetch the public app config. */
export function fetchConfig(): Promise<AppConfig> {
  return apiFetch(appConfigSchema, apiRoutes.config());
}

/** Fetch the current authenticated identity (design.md §11). */
export function fetchMe(): Promise<MeResponse> {
  return apiFetch(meResponseSchema, apiRoutes.me());
}

export { apiRoutes };

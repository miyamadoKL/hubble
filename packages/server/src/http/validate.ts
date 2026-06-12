import type { Context } from 'hono';
import { AppError } from '../errors';

/** Minimal structural view of a zod schema — avoids a direct zod dependency. */
interface SafeParser<T> {
  safeParse(
    value: unknown,
  ):
    | { success: true; data: T }
    | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } };
}

/** Parse + validate a JSON body against a zod schema, throwing AppError(400). */
export async function parseJsonBody<T>(c: Context, schema: SafeParser<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw AppError.badRequest('Request body must be valid JSON');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    throw AppError.badRequest(formatIssues(result.error.issues), 'VALIDATION_ERROR');
  }
  return result.data;
}

/** Parse a non-negative integer query param, returning a fallback when absent. */
export function intParam(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function formatIssues(issues: { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    })
    .join('; ');
}

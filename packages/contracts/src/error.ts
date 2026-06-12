import { z } from 'zod';

/**
 * Common API error envelope (design.md §7).
 * Every API failure returns this shape: `{ error: { ... } }`.
 */
export const apiErrorDetailSchema = z.object({
  /** Stable, machine-readable error code (e.g. 'TRINO_ERROR', 'NOT_FOUND'). */
  code: z.string().min(1),
  /** Human-readable message. */
  message: z.string(),
  /** Trino's error name when the failure originates from Trino (e.g. 'SYNTAX_ERROR'). */
  trinoErrorName: z.string().optional(),
  /** 1-based source line of a query error, when available. */
  line: z.number().int().positive().optional(),
  /** 1-based source column of a query error, when available. */
  column: z.number().int().positive().optional(),
});

export const apiErrorSchema = z.object({
  error: apiErrorDetailSchema,
});

export type ApiErrorDetail = z.infer<typeof apiErrorDetailSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;

/**
 * Error code returned (HTTP 401) when the request could not be authenticated in
 * `proxy` mode — SSO headers were missing or arrived from an untrusted source
 * (design.md §11). The web treats this code as the signal to show the global
 * "authentication required" screen.
 */
export const UNAUTHENTICATED = 'UNAUTHENTICATED';

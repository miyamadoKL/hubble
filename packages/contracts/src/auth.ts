import { z } from 'zod';

/**
 * Authentication contract (design.md §11). The server runs in one of two modes:
 * `none` (no auth; principal is the configured `TRINO_USER`) or `proxy` (behind
 * oauth2-proxy; principal is resolved from trusted SSO headers).
 */
export const authModeSchema = z.enum(['none', 'proxy']);
export type AuthMode = z.infer<typeof authModeSchema>;

/**
 * `GET /api/me` response (design.md §11). `user` is the resolved principal
 * (owner id + Trino execution user). `email` is present only when a proxy
 * supplied it. In `none` mode the web hides the user chip.
 */
export const meResponseSchema = z.object({
  user: z.string().min(1),
  email: z.string().optional(),
  authMode: authModeSchema,
});
export type MeResponse = z.infer<typeof meResponseSchema>;

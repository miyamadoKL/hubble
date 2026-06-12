import { z } from 'zod';
import { authModeSchema } from './auth';

/**
 * App config exposed via `GET /api/config` (design.md §7).
 * Built server-side from env vars and validated before being sent to the client.
 */
export const appDefaultsSchema = z.object({
  catalog: z.string().optional(),
  schema: z.string().optional(),
  /** Default LIMIT auto-appended to LIMIT-less SELECT statements. */
  limit: z.number().int().positive(),
});

export const trinoConfigSchema = z.object({
  url: z.url(),
  user: z.string().min(1),
});

export const appConfigSchema = z.object({
  trino: trinoConfigSchema,
  defaults: appDefaultsSchema,
  /** Active authentication mode (design.md §11); web hides the user chip in `none`. */
  authMode: authModeSchema,
  version: z.string().min(1),
});

export type AppDefaults = z.infer<typeof appDefaultsSchema>;
export type TrinoConfig = z.infer<typeof trinoConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

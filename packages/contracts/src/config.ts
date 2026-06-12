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

/** Query Guard operating mode (Query Guard feature). */
export const guardModeSchema = z.enum(['off', 'warn', 'enforce']);
export type GuardMode = z.infer<typeof guardModeSchema>;

/** What to do when scan cost cannot be estimated. */
export const guardOnUnknownSchema = z.enum(['allow', 'warn', 'block']);
export type GuardOnUnknown = z.infer<typeof guardOnUnknownSchema>;

/**
 * Public Query Guard config exposed via `GET /api/config`. The web uses it to
 * decide whether to call `/estimate` and how to surface the verdict.
 */
export const guardConfigSchema = z.object({
  mode: guardModeSchema,
  /** Scan-bytes limit (0 = no limit). */
  maxScanBytes: z.number().int().nonnegative(),
  /** Scan-rows limit (0 = no limit). */
  maxScanRows: z.number().int().nonnegative(),
  onUnknown: guardOnUnknownSchema,
  /** Cluster throughput estimate for `estimatedSeconds` (0 = no time prediction). */
  bytesPerSecond: z.number().int().nonnegative(),
});
export type GuardConfig = z.infer<typeof guardConfigSchema>;

export const appConfigSchema = z.object({
  trino: trinoConfigSchema,
  defaults: appDefaultsSchema,
  /** Active authentication mode (design.md §11); web hides the user chip in `none`. */
  authMode: authModeSchema,
  /** Query Guard settings (Query Guard feature). */
  guard: guardConfigSchema,
  version: z.string().min(1),
});

export type AppDefaults = z.infer<typeof appDefaultsSchema>;
export type TrinoConfig = z.infer<typeof trinoConfigSchema>;
export type AppConfig = z.infer<typeof appConfigSchema>;

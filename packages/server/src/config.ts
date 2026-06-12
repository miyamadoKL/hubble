import { appConfigSchema, type AppConfig, type AuthMode } from '@hue-fable/contracts';

/** How a proxy-supplied principal is derived from SSO headers (design.md §11). */
export type UserMapping = 'email-localpart' | 'email' | 'user';

/** Authentication configuration (design.md §11). */
export interface AuthConfig {
  /** `none`: no auth, principal is `trino.user`. `proxy`: SSO headers. */
  mode: AuthMode;
  /** Raw trusted-proxy CIDR list (parsed lazily by the auth layer). */
  trustedProxyCidrs: string;
  /** Lower-cased header name carrying the SSO user. */
  ssoHeaderUser: string;
  /** Lower-cased header name carrying the SSO email. */
  ssoHeaderEmail: string;
  /** Principal derivation strategy. */
  userMapping: UserMapping;
}

/** Server runtime configuration, derived from environment variables. */
export interface ServerConfig {
  port: number;
  dbPath: string;
  /**
   * Directory of the built web app to serve (e.g. `web/dist`). When set, the
   * server serves these static files and falls back to `index.html` for any
   * non-`/api` path (SPA). Unset (default) = API-only, no static serving.
   */
  staticDir?: string;
  auth: AuthConfig;
  trino: {
    baseUrl: string;
    username: string;
    password: string;
    /** Value sent as `X-Trino-User`. */
    user: string;
    /** `X-Trino-Source` for user queries. */
    source: string;
    /** `X-Trino-Source` for metadata queries. */
    metadataSource: string;
  };
  defaults: {
    catalog?: string;
    schema?: string;
    limit: number;
  };
  query: {
    /** Default cap on rows buffered server-side per query. */
    maxRows: number;
    /** Maximum number of queries running (追走中) concurrently. */
    concurrency: number;
    /** Minutes a finished query is retained before sweep. */
    ttlMinutes: number;
    /** What to do when a query exceeds `maxRows`: truncate buffering or cancel. */
    overflowMode: 'truncate' | 'cancel';
  };
  metadata: {
    /** TTL for metadata cache entries, in seconds. */
    ttlSeconds: number;
  };
  version: string;
}

type Env = Record<string, string | undefined>;

function envStr(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** Allows explicitly empty string (e.g. an empty Trino password). */
function envStrAllowEmpty(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined ? fallback : v;
}

function envInt(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for env var ${key}: ${JSON.stringify(v)}`);
  }
  return n;
}

function envOptional(env: Env, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

function envEnum<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(
    `Invalid value for env var ${key}: ${JSON.stringify(v)} (allowed: ${allowed.join(', ')})`,
  );
}

export function loadServerConfig(env: Env = process.env): ServerConfig {
  return {
    port: envInt(env, 'PORT', 8080),
    dbPath: envStr(env, 'DB_PATH', './data/hue_fable.db'),
    staticDir: envOptional(env, 'STATIC_DIR'),
    auth: {
      mode: envEnum(env, 'AUTH_MODE', ['none', 'proxy'] as const, 'none'),
      trustedProxyCidrs: envStr(env, 'AUTH_TRUSTED_PROXY_CIDRS', '127.0.0.0/8,::1/128'),
      // Header names are compared case-insensitively; normalize to lower-case.
      ssoHeaderUser: envStr(env, 'AUTH_SSO_HEADER_USER', 'x-forwarded-user').toLowerCase(),
      ssoHeaderEmail: envStr(env, 'AUTH_SSO_HEADER_EMAIL', 'x-forwarded-email').toLowerCase(),
      userMapping: envEnum(
        env,
        'AUTH_USER_MAPPING',
        ['email-localpart', 'email', 'user'] as const,
        'email-localpart',
      ),
    },
    trino: {
      baseUrl: envStr(env, 'TRINO_BASE_URL', 'http://127.0.0.1:30080'),
      username: envStr(env, 'TRINO_USERNAME', 'admin'),
      password: envStrAllowEmpty(env, 'TRINO_PASSWORD', ''),
      user: envStr(env, 'TRINO_USER', 'admin'),
      source: envStr(env, 'TRINO_SOURCE', 'hubble'),
      metadataSource: envStr(env, 'TRINO_METADATA_SOURCE', 'hubble-metadata'),
    },
    defaults: {
      catalog: envOptional(env, 'DEFAULT_CATALOG'),
      schema: envOptional(env, 'DEFAULT_SCHEMA'),
      limit: envInt(env, 'DEFAULT_LIMIT', 5000),
    },
    query: {
      maxRows: envInt(env, 'QUERY_MAX_ROWS', 100_000),
      concurrency: envInt(env, 'QUERY_CONCURRENCY', 5),
      ttlMinutes: envInt(env, 'QUERY_TTL_MINUTES', 30),
      overflowMode: envEnum(
        env,
        'QUERY_OVERFLOW_MODE',
        ['truncate', 'cancel'] as const,
        'truncate',
      ),
    },
    metadata: {
      ttlSeconds: envInt(env, 'METADATA_TTL_SECONDS', 300),
    },
    version: envStr(env, 'APP_VERSION', '0.1.0'),
  };
}

/**
 * Build the public `AppConfig` (design.md §7) from server config and validate it
 * against the contract before exposing it via `GET /api/config`.
 */
export function toAppConfig(config: ServerConfig): AppConfig {
  return appConfigSchema.parse({
    trino: {
      url: config.trino.baseUrl,
      user: config.trino.user,
    },
    defaults: {
      catalog: config.defaults.catalog,
      schema: config.defaults.schema,
      limit: config.defaults.limit,
    },
    authMode: config.auth.mode,
    version: config.version,
  });
}

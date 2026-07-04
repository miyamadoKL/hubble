/**
 * hubble server の設定モジュール。
 *
 * 環境変数を唯一の設定入力源とし、型付きの `ServerConfig` に変換する責務を持つ。
 * `loadServerConfig()` がエントリーポイント（index.ts / app.ts の defaultServices）
 * から呼ばれ、以後アプリ全体はこの `ServerConfig` オブジェクトを介して設定を参照する
 * （環境変数を直接読む箇所を config.ts に閉じ込めることで、テストでの差し替えや
 * 設定値の一覧性を確保する）。
 *
 * また `toAppConfig()` は、この内部設定のうちフロントエンドに公開してよい部分だけを
 * 抜き出して `GET /api/config` のレスポンス（packages/contracts の契約スキーマ）に
 * 変換する。Trino のパスワード等の機密情報はここで意図的に除外される。
 */
import {
  appConfigSchema,
  type AppConfig,
  type AuthMode,
  type GuardMode,
  type GuardOnUnknown,
} from '@hubble/contracts';

/** How a proxy-supplied principal is derived from SSO headers. */
/** 日本語: `AUTH_USER_MAPPING` で選択する、SSO ヘッダから principal（実行ユーザー名）を
 * 導出する方式。`email-localpart` はメールの `@` より前の部分、`email` はメール全体、
 * `user` はユーザーヘッダの値をそのまま使う。 */
export type UserMapping = 'email-localpart' | 'email' | 'user';

/** Authentication configuration. */
/** 日本語: 認証まわりの設定一式。`AUTH_MODE=none`（既定）ではほぼ無視され、
 * `AUTH_MODE=proxy`（oauth2-proxy 前段 SSO）のときにのみ意味を持つ。 */
export interface AuthConfig {
  /** `none`: no auth, principal is `trino.user`. `proxy`: SSO headers. */
  mode: AuthMode;
  /** Raw trusted-proxy CIDR list (parsed lazily by the auth layer). */
  /** 日本語: SSO ヘッダを信頼してよいリクエスト元 CIDR のカンマ区切りリスト（生文字列）。
   * 実際の CIDR パース/マッチングは auth 層（auth/cidr.ts）が遅延実行する。
   * 信頼範囲外からの SSO ヘッダはなりすまし対策として無視される。 */
  trustedProxyCidrs: string;
  /** Lower-cased header name carrying the SSO user. */
  ssoHeaderUser: string;
  /** Lower-cased header name carrying the SSO email. */
  ssoHeaderEmail: string;
  /** Lower-cased header name carrying SSO group membership (oauth2-proxy 等)。 */
  ssoHeaderGroups: string;
  /** Principal derivation strategy. */
  userMapping: UserMapping;
}

/**
 * Selected persistence backend. `sqlite` is the historical
 * default (`DB_PATH`); `postgres` is selected when `DATABASE_URL` is a
 * `postgres://` / `postgresql://` URL.
 *
 * 日本語: 選択された永続化バックエンド。判別共用体 (discriminated union) になっており、
 * `kind` の値によって `path`（SQLite のファイルパス）と `url`（PostgreSQL の接続文字列）
 * のどちらを持つかが決まる。両方を同時に持つことはない。
 */
export type DatabaseConfig = { kind: 'sqlite'; path: string } | { kind: 'postgres'; url: string };

/** Server runtime configuration, derived from environment variables. */
/** 日本語: サーバー実行時設定。`loadServerConfig()` が環境変数から一度だけ構築し、
 * 以後は不変な値としてアプリ全体（Services グラフ）に注入される。 */
export interface ServerConfig {
  /** 日本語: HTTP リッスンポート（`PORT`、既定 8080）。 */
  port: number;
  /** Resolved persistence backend (DATABASE_URL takes precedence over DB_PATH). */
  /** 日本語: `DATABASE_URL`（postgres://.. なら PostgreSQL）を優先し、未設定なら
   * `DB_PATH`（既定 `./data/hubble.db`）を使う SQLite にフォールバックする。 */
  database: DatabaseConfig;
  /**
   * Directory of the built web app to serve (e.g. `web/dist`). When set, the
   * server serves these static files and falls back to `index.html` for any
   * non-`/api` path (SPA). Unset (default) = API-only, no static serving.
   *
   * 日本語: `STATIC_DIR` 環境変数。設定するとビルド済み web アプリ (dist) を
   * 静的配信し、非 `/api` パスは SPA のため `index.html` にフォールバックする。
   * 未設定（既定）の場合は API 専用サーバーとして動作し、静的配信は行わない。
   */
  staticDir?: string;
  /** 日本語: 認証設定一式（`AUTH_MODE` ほか、下記 AuthConfig 参照）。 */
  auth: AuthConfig;
  /** 日本語: Trino 接続設定一式。`TRINO_*` 環境変数群から組み立てる。 */
  trino: {
    /** 日本語: Trino coordinator の URL（`TRINO_BASE_URL`、既定 `http://127.0.0.1:30080`）。 */
    baseUrl: string;
    /** 日本語: Trino への Basic 認証ユーザー名（`TRINO_USERNAME`、既定 `admin`）。
     * これは技術アカウントであり、実行ユーザーの impersonation は `user`/`X-Trino-User` で行う。 */
    username: string;
    /** 日本語: Trino への Basic 認証パスワード（`TRINO_PASSWORD`、既定は空文字）。 */
    password: string;
    /** Value sent as `X-Trino-User`. */
    /** 日本語: `TRINO_USER`（既定 `admin`）。AUTH_MODE=none の場合は常にこの値が
     * principal になる。proxy モードでは impersonation 対象のベースにはならず、
     * メタデータ取得用の技術 principal として使われる。 */
    user: string;
    /** `X-Trino-Source` for user queries. */
    /** 日本語: `TRINO_SOURCE`（既定 `hubble`）。ユーザーが発行するクエリに付与し、
     * resource group をソース別に分けられるようにする。 */
    source: string;
    /** `X-Trino-Source` for metadata queries. */
    /** 日本語: `TRINO_METADATA_SOURCE`（既定 `hubble-metadata`）。カタログ一覧等の
     * メタデータ取得クエリに付与するソース種別。 */
    metadataSource: string;
    /** `X-Trino-Source` for scheduled runs (Query Scheduling feature). */
    /** 日本語: `TRINO_SCHEDULED_SOURCE`（既定 `hubble-scheduled`）。スケジューラーが
     * 発行するクエリに付与するソース種別。 */
    scheduledSource: string;
  };
  /** 日本語: 新規 notebook/クエリ実行のデフォルト値（`DEFAULT_CATALOG` / `DEFAULT_SCHEMA` / `DEFAULT_LIMIT`）。 */
  defaults: {
    catalog?: string;
    schema?: string;
    /** 日本語: SELECT に LIMIT が無い場合に自動付加する既定件数（`DEFAULT_LIMIT`、既定 5000）。 */
    limit: number;
  };
  /** 日本語: クエリ実行とページストアの挙動を制御する設定群（`QUERY_*`）。 */
  query: {
    /** Default cap on rows buffered server-side per query. */
    /** 日本語: `QUERY_MAX_ROWS`（既定 100,000）。クエリ 1 件あたりサーバーメモリに
     * バッファする行数の上限。 */
    maxRows: number;
    /** Maximum number of queries running (追走中) concurrently. */
    /** 日本語: `QUERY_CONCURRENCY`（既定 5）。同時に nextUri を追走できるクエリ数の
     * 上限（semaphore で制御）。 */
    concurrency: number;
    /** Minutes a finished query is retained before sweep. */
    /** 日本語: `QUERY_TTL_MINUTES`（既定 30）。完了済みクエリをレジストリに保持する分数。
     * 経過後は sweep（削除）される。 */
    ttlMinutes: number;
    /** What to do when a query exceeds `maxRows`: truncate buffering or cancel. */
    /** 日本語: `QUERY_OVERFLOW_MODE`（既定 `truncate`）。`maxRows` を超えた場合の挙動。
     * `truncate` はバッファへの追加のみ止めてクエリ自体は継続、`cancel` は Trino 側の
     * クエリごとキャンセルする。 */
    overflowMode: 'truncate' | 'cancel';
  };
  /** 日本語: メタデータキャッシュの設定（`METADATA_TTL_SECONDS`）。 */
  metadata: {
    /** TTL for metadata cache entries, in seconds. */
    /** 日本語: `METADATA_TTL_SECONDS`（既定 300）。カタログ/スキーマ/テーブル情報の
     * キャッシュ TTL。期限切れ後は stale-while-revalidate で古い値を返しつつ裏で更新する。 */
    ttlSeconds: number;
  };
  /** Query Guard configuration (Query Guard feature). */
  /** 日本語: Query Guard（EXPLAIN (TYPE IO) による事前スキャン量見積もり）機能の設定。
   * `QUERY_GUARD_*` 環境変数群から組み立てる。 */
  guard: {
    /** `off` disables the feature entirely (no estimation). */
    /** 日本語: `QUERY_GUARD_MODE`（既定 `warn`）。`off` は見積もり自体を行わない、
     * `warn` は超過しても実行は許可し警告のみ、`enforce` は超過時に 422 で実行をブロックする。 */
    mode: GuardMode;
    /** Scan-bytes limit (0 = no limit). */
    /** 日本語: `QUERY_GUARD_MAX_SCAN_BYTES`（既定 0 = 無制限）。見積もりスキャンバイト数の上限。 */
    maxScanBytes: number;
    /** Scan-rows limit (0 = no limit). */
    /** 日本語: `QUERY_GUARD_MAX_SCAN_ROWS`（既定 0 = 無制限）。見積もりスキャン行数の上限。 */
    maxScanRows: number;
    /** How to treat a query whose scan cost cannot be estimated. */
    /** 日本語: `QUERY_GUARD_ON_UNKNOWN`（既定 `warn`）。EXPLAIN が失敗/タイムアウトして
     * 見積もり不能だった場合の扱い（`allow`/`warn`/`block`）。 */
    onUnknown: GuardOnUnknown;
    /** EXPLAIN timeout in ms; exceeded => estimation unavailable. */
    /** 日本語: `QUERY_GUARD_ESTIMATE_TIMEOUT_MS`（既定 3000）。EXPLAIN 実行のタイムアウト。
     * 超過すると見積もり不能扱いとなり `onUnknown` の方針に従う。 */
    estimateTimeoutMs: number;
    /** Estimate-result cache TTL, in seconds. */
    /** 日本語: `QUERY_GUARD_CACHE_TTL_SECONDS`（既定 30）。同一クエリの見積もり結果を
     * 再利用するキャッシュの TTL。 */
    cacheTtlSeconds: number;
    /** Cluster throughput estimate for `estimatedSeconds` (0 = no prediction). */
    /** 日本語: `QUERY_GUARD_BYTES_PER_SECOND`（既定 0 = 予測しない）。クラスタの
     * スループット見積もり値で、見積もり所要時間 (`estimatedSeconds`) の算出に使う。 */
    bytesPerSecond: number;
  };
  /** Query Scheduling configuration (Query Scheduling feature). */
  /** 日本語: cron スケジューラー（Query Scheduling 機能）の設定。`SCHEDULER_*` から組み立てる。 */
  scheduler: {
    /** When false, the API stays live but the tick loop never starts. */
    /** 日本語: `SCHEDULER_ENABLED`（既定 true）。false でも API 自体は生きているが、
     * 定期的にスケジュール実行時刻をスキャンするティックループは開始しない。 */
    enabled: boolean;
    /** Seconds between due-schedule scans. */
    /** 日本語: `SCHEDULER_TICK_SECONDS`（既定 15）。実行時刻を迎えたスケジュールが
     * ないかをスキャンする周期（秒）。 */
    tickSeconds: number;
    /** Max schedules running concurrently across the scheduler. */
    /** 日本語: `SCHEDULER_MAX_CONCURRENT`（既定 2）。スケジューラー全体で同時実行できる
     * スケジュール数の上限。 */
    maxConcurrent: number;
    /** Per-schedule cap on retained `schedule_runs` rows (older are pruned). */
    /** 日本語: `SCHEDULER_RUNS_RETENTION`（既定 50）。スケジュールごとに保持する
     * 実行履歴 (`schedule_runs`) の件数上限。超過分は古い順に削除される。 */
    runsRetention: number;
  };
  /** 日本語: `APP_VERSION`（既定 `0.1.0`）。`GET /api/config` で公開されるバージョン表示用文字列。 */
  version: string;
}

// 日本語: 以降は環境変数を型付きの値へ変換する小さなヘルパー群。
// `process.env` を直接読む代わりにこれらを経由することで、テストからは任意の
// `Env`（プレーンオブジェクト）を注入でき、かつ不正値の検出を一箇所に集約できる。
type Env = Record<string, string | undefined>;

// 未設定 または 空文字列 の場合にフォールバック値を返す（最も一般的な文字列取得）。
function envStr(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined || v === '' ? fallback : v;
}

/** Allows explicitly empty string (e.g. an empty Trino password). */
// 日本語: 空文字列を「明示的な空値」として許容する版。TRINO_PASSWORD のように
// 「未設定=デフォルト」と「空文字列=パスワードなしを明示」を区別したい場合に使う。
function envStrAllowEmpty(env: Env, key: string, fallback: string): string {
  const v = env[key];
  return v === undefined ? fallback : v;
}

// 整数値を読む。パース不能な値は起動時エラーとして即座に落とす（サイレントに
// 不正な設定のまま起動してしまうことを防ぐ）。
function envInt(env: Env, key: string, fallback: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for env var ${key}: ${JSON.stringify(v)}`);
  }
  return n;
}

// 値が無ければ undefined を返す（DEFAULT_CATALOG のように「未設定なら機能自体を
// 使わない」というオプショナル項目向け）。
function envOptional(env: Env, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v === '' ? undefined : v;
}

/** Parse a boolean env var. Accepts true/1/yes/on and false/0/no/off (any case). */
// 日本語: 真偽値環境変数のパーサー。true/1/yes/on と false/0/no/off を大文字小文字を
// 無視して受け付け、どちらにも該当しない値は起動時エラーにする。
function envBool(env: Env, key: string, fallback: boolean): boolean {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const normalized = v.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`Invalid boolean for env var ${key}: ${JSON.stringify(v)}`);
}

// 日本語: 列挙型環境変数のパーサー（AUTH_MODE, QUERY_GUARD_MODE 等）。許可リストに
// 無い値は起動時エラーにし、タイポ等の設定ミスを早期に検出する。
function envEnum<T extends string>(env: Env, key: string, allowed: readonly T[], fallback: T): T {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  if ((allowed as readonly string[]).includes(v)) return v as T;
  throw new Error(
    `Invalid value for env var ${key}: ${JSON.stringify(v)} (allowed: ${allowed.join(', ')})`,
  );
}

/**
 * Resolve the persistence backend. `DATABASE_URL` (a `postgres://` /
 * `postgresql://` URL) selects PostgreSQL and takes precedence over `DB_PATH`
 * (SQLite, the default). An unset/empty `DATABASE_URL` falls back to SQLite. A
 * `DATABASE_URL` with any other scheme is a startup error.
 *
 * 日本語: 永続化バックエンドを決定する。`DATABASE_URL` が設定されていれば
 * （スキームが postgres:// / postgresql:// であることを検証したうえで）PostgreSQL を
 * 選び、`DB_PATH` より優先する。`DATABASE_URL` が未設定/空文字なら SQLite
 * （`DB_PATH`、既定 `./data/hubble.db`）にフォールバックする。サポート外スキームは
 * 起動時エラーとして即座に検出する。
 */
export function resolveDatabaseConfig(env: Env): DatabaseConfig {
  const url = envOptional(env, 'DATABASE_URL');
  if (url !== undefined) {
    let scheme: string;
    try {
      scheme = new URL(url).protocol.replace(/:$/, '');
    } catch {
      throw new Error(`Invalid DATABASE_URL: ${JSON.stringify(url)} is not a valid URL`);
    }
    // postgres:// / postgresql:// 以外のスキームは想定外の設定ミスとして拒否する。
    if (scheme !== 'postgres' && scheme !== 'postgresql') {
      throw new Error(
        `Unsupported DATABASE_URL scheme ${JSON.stringify(scheme)}: ` +
          'only postgres:// / postgresql:// (PostgreSQL) or DB_PATH (SQLite) are supported',
      );
    }
    return { kind: 'postgres', url };
  }
  // DATABASE_URL 未設定時は歴史的デフォルトである SQLite を使う。
  return { kind: 'sqlite', path: envStr(env, 'DB_PATH', './data/hubble.db') };
}

/**
 * 日本語: 環境変数（既定は `process.env`、テストでは任意のオブジェクトを注入可能）から
 * `ServerConfig` を組み立てるエントリーポイント。各セクション（auth/trino/defaults/
 * query/metadata/guard/scheduler）ごとに対応する環境変数を読み、上の `env*` ヘルパーで
 * 型変換、デフォルト適用、不正値検出を行う。
 */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  return {
    port: envInt(env, 'PORT', 8080),
    database: resolveDatabaseConfig(env),
    staticDir: envOptional(env, 'STATIC_DIR'),
    auth: {
      mode: envEnum(env, 'AUTH_MODE', ['none', 'proxy'] as const, 'none'),
      trustedProxyCidrs: envStr(env, 'AUTH_TRUSTED_PROXY_CIDRS', '127.0.0.0/8,::1/128'),
      // Header names are compared case-insensitively; normalize to lower-case.
      // 日本語: ヘッダ名は大文字小文字を無視して比較するため、ここで小文字に正規化しておく。
      ssoHeaderUser: envStr(env, 'AUTH_SSO_HEADER_USER', 'x-forwarded-user').toLowerCase(),
      ssoHeaderEmail: envStr(env, 'AUTH_SSO_HEADER_EMAIL', 'x-forwarded-email').toLowerCase(),
      ssoHeaderGroups: envStr(env, 'AUTH_SSO_HEADER_GROUPS', 'x-forwarded-groups').toLowerCase(),
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
      scheduledSource: envStr(env, 'TRINO_SCHEDULED_SOURCE', 'hubble-scheduled'),
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
    guard: {
      mode: envEnum(env, 'QUERY_GUARD_MODE', ['off', 'warn', 'enforce'] as const, 'warn'),
      maxScanBytes: envInt(env, 'QUERY_GUARD_MAX_SCAN_BYTES', 0),
      maxScanRows: envInt(env, 'QUERY_GUARD_MAX_SCAN_ROWS', 0),
      onUnknown: envEnum(
        env,
        'QUERY_GUARD_ON_UNKNOWN',
        ['allow', 'warn', 'block'] as const,
        'warn',
      ),
      estimateTimeoutMs: envInt(env, 'QUERY_GUARD_ESTIMATE_TIMEOUT_MS', 3000),
      cacheTtlSeconds: envInt(env, 'QUERY_GUARD_CACHE_TTL_SECONDS', 30),
      bytesPerSecond: envInt(env, 'QUERY_GUARD_BYTES_PER_SECOND', 0),
    },
    scheduler: {
      enabled: envBool(env, 'SCHEDULER_ENABLED', true),
      tickSeconds: envInt(env, 'SCHEDULER_TICK_SECONDS', 15),
      maxConcurrent: envInt(env, 'SCHEDULER_MAX_CONCURRENT', 2),
      runsRetention: envInt(env, 'SCHEDULER_RUNS_RETENTION', 50),
    },
    version: envStr(env, 'APP_VERSION', '0.1.0'),
  };
}

/**
 * Build the public `AppConfig` from server config and validate it
 * against the contract before exposing it via `GET /api/config`.
 *
 * 日本語: `ServerConfig`（内部設定、Trino パスワード等の機密情報を含む）から
 * フロントエンドに公開してよい部分だけを抜き出し、`GET /api/config` で返す
 * `AppConfig`（packages/contracts の契約スキーマ）を組み立てる。`appConfigSchema.parse`
 * によって契約に沿った形になっているかをここで検証する（サーバー起動直後の
 * 設定ミスをテスト/起動時に検出できるようにするため）。
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
    guard: {
      mode: config.guard.mode,
      maxScanBytes: config.guard.maxScanBytes,
      maxScanRows: config.guard.maxScanRows,
      onUnknown: config.guard.onUnknown,
      bytesPerSecond: config.guard.bytesPerSecond,
    },
    version: config.version,
  });
}

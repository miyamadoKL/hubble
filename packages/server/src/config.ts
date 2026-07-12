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
import type { ResolvedDatasource } from './datasource/types';
import { parseCidrList, type ParsedCidr } from './auth/cidr';
import { isValidCron } from './schedule/cron';
import { DEFAULT_POSTGRES_TIMEOUTS, type PostgresTimeouts } from './db/postgresTimeouts';
import type { TokenEncryptionKeyring } from './github/crypto';

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
 * 選択された永続化バックエンド。判別共用体になっており、
 * `kind` の値によって `path`（SQLite のファイルパス）と `url`（PostgreSQL の接続文字列）
 * のどちらを持つかが決まる。PostgreSQL の場合はアプリ永続化専用の期限設定も持つ。
 */
export type DatabaseConfig =
  | { kind: 'sqlite'; path: string }
  | { kind: 'postgres'; url: string; timeouts: PostgresTimeouts };

/** クエリ結果保存バックエンド設定。 */
export type ResultStoreConfig =
  | { kind: 'none'; ttlDays: number }
  | {
      kind: 's3';
      bucket: string;
      prefix: string;
      region?: string;
      endpoint?: string;
      ttlDays: number;
    };

/** クエリ結果エクスポート設定。 */
export interface ExportConfig {
  /** S3 互換ストレージへのエクスポート設定。bucket 未設定なら無効。 */
  s3: {
    bucket?: string;
    prefix: string;
    region?: string;
    endpoint?: string;
  };
  /** Google Sheets へのエクスポート設定。credentialsFile 未設定なら無効。 */
  sheets: {
    credentialsFile?: string;
  };
}

/** Server runtime configuration, derived from environment variables. */
/** 日本語: サーバー実行時設定。`loadServerConfig()` が環境変数から一度だけ構築し、
 * 以後は不変な値としてアプリ全体（Services グラフ）に注入される。 */
export interface ServerConfig {
  /** 日本語: HTTP リッスンポート（`PORT`、既定 8080）。 */
  port: number;
  /** `SHUTDOWN_TIMEOUT_MS`。受付停止から強制closeへ移るまでの期限。 */
  shutdownTimeoutMs: number;
  /** HTTP リクエスト受け付け時の資源上限。 */
  http: {
    /** `HTTP_MAX_BODY_BYTES`。API request body 全体の最大 byte 数。 */
    maxBodyBytes: number;
  };
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
  /**
   * 日本語: Trino 関連の横断設定。データソース個別の接続情報(baseUrl/username/password/
   * source 系)は `datasources.yaml`（`packages/server/src/datasource/schema.ts`）が
   * 一次情報源であり、ここには全 Trino データソースに共通する impersonation
   * ユーザーのみを残す(Postgres ファースト移行により TRINO_BASE_URL 等の
   * レガシー自動合成パスは廃止された)。
   */
  trino: {
    /** Value sent as `X-Trino-User`. */
    /** 日本語: `TRINO_USER`（既定 `admin`）。全 Trino データソース共通の impersonation
     * ユーザー。AUTH_MODE=none の場合は常にこの値が principal になり、owner
     * backfill(db/backfill.ts)の初期値としても使われる。proxy モードでは SSO から
     * 解決した principal が実際の X-Trino-User として使われる。 */
    user: string;
  };
  /** 候補データソースを公開する前の疎通確認期限。 */
  datasourceProbeTimeoutMs: number;
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
    /** 実行枠を待てるクエリの全体上限。 */
    maxQueued: number;
    /** 同一 principal が実行枠を待てるクエリの上限。 */
    maxQueuedPerPrincipal: number;
    /** 終端済みを含め、registry が保持する QueryExecution の上限。 */
    maxTracked: number;
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
  /** 日本語: クエリ結果保存バックエンドの設定（`RESULT_STORE_*`）。 */
  resultStore: ResultStoreConfig;
  /** 日本語: クエリ結果エクスポート先の設定（`EXPORT_*`）。 */
  export: ExportConfig;
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
    /** 日本語: `SCHEDULER_MAX_CONCURRENT`（既定 2）。schedule、workflow step、alert が
     * 共有する statement 同時実行数の上限。 */
    maxConcurrent: number;
    /** Per-schedule cap on retained `schedule_runs` rows (older are pruned). */
    /** 日本語: `SCHEDULER_RUNS_RETENTION`（既定 50）。スケジュールごとに保持する
     * 実行履歴 (`schedule_runs`) の件数上限。超過分は古い順に削除される。 */
    runsRetention: number;
  };
  /** スケジュール失敗通知の送信設定。 */
  notification: {
    /** Slack incoming webhook URL。 */
    slackWebhookUrl?: string;
    /** 予約レンジへの webhook 送信を上書き許可する CIDR。 */
    webhookAllowedCidrs: ParsedCidr[];
    /** webhook URL で http scheme を許可するか。 */
    webhookAllowHttp: boolean;
    /** webhook 送信のタイムアウト。 */
    webhookTimeoutMs: number;
    /** 単一通知チャネルの送信タイムアウト。 */
    channelTimeoutMs: number;
    /** SMTP 送信設定。 */
    smtp: {
      host?: string;
      port: number;
      user?: string;
      password?: string;
      from?: string;
    };
  };
  /** Alert通知outbox workerの設定。 */
  alertDelivery: {
    /** dueジョブを確認する周期。 */
    intervalMs: number;
    /** deadへ移すまでの最大試行回数。 */
    maxAttempts: number;
    /** 指数backoffの基準時間。 */
    backoffMs: number;
  };
  /** 永続テーブルの保持期限とページ削除設定。 */
  dataRetention: {
    /** sent または dead になった Alert 配信ジョブの保持日数。0 は自動削除しない。 */
    alertDeliveryDays: number;
    /** S3 object 参照を持たないクエリ履歴の保持日数。0 は自動削除しない。 */
    queryHistoryDays: number;
    /** 監査ログの保持日数。0 は自動削除しない。 */
    auditLogDays: number;
    /** 1回の DELETE で処理する最大行数。 */
    batchSize: number;
  };
  /** GitHub 連携設定。 */
  github: GithubConfig;
  /** AI アシスタント設定（`AI_*` 環境変数群）。 */
  ai: AiConfig;
  /** 日本語: `APP_VERSION`（既定 `0.1.0`）。`GET /api/config` で公開されるバージョン表示用文字列。 */
  version: string;
}

/** AI アシスタント設定。provider が off のときは API key 等を持たない。 */
export type AiConfig =
  | { provider: 'off' }
  | {
      provider: 'gemini-api' | 'github-models';
      model: string;
      apiKey: string;
      timeoutMs: number;
      maxConcurrency: number;
      perPrincipalPerMinute: number;
      maxResponseBytes: number;
      maxOutputTokens: number;
    };

/** GitHub 連携のガバナンスモード。強制は後続タスクで実装する。 */
export type GithubGovernance = 'off' | 'on';

/** GitHub 連携設定。`GITHUB_REPO` 未設定時は enabled=false。 */
export interface GithubConfig {
  /** GITHUB_REPO が設定されている場合のみ true。 */
  enabled: boolean;
  /** owner/repo 形式。enabled 時のみ設定される。 */
  repo?: string;
  /** デフォルトブランチ名。 */
  defaultBranch: string;
  /** GitHub App OAuth client id。enabled 時のみ設定される。 */
  clientId?: string;
  /** GitHub App OAuth client secret。enabled 時のみ設定される。 */
  clientSecret?: string;
  /** AES-256-GCM 用 32 バイト鍵。enabled 時のみ設定される。 */
  tokenEncryptionKey?: Buffer;
  /** Token envelopeのactive key IDと旧鍵を含む復号用keyring。 */
  tokenEncryptionKeys?: TokenEncryptionKeyring;
  /** ガバナンスモード (config 載せのみ)。 */
  governance: GithubGovernance;
  /** 承認状態キャッシュの TTL (秒)。 */
  statusTtlSeconds: number;
  /** 定時同期の cron 式。null のとき定時同期は無効。 */
  syncCron: string | null;
  /** 定時同期の読み取り用サーバートークン (任意)。 */
  syncToken?: string;
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

// 整数値を読む。パース不能な値は起動時エラーとして即座に落とす（サイレントに
// 不正な設定のまま起動してしまうことを防ぐ）。
function envInt(env: Env, key: string, fallback: number, min?: number): number {
  const v = env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) {
    throw new Error(`Invalid integer for env var ${key}: ${JSON.stringify(v)}`);
  }
  if (min !== undefined && n < min) {
    throw new Error(`Invalid integer for env var ${key}: ${JSON.stringify(v)} (minimum: ${min})`);
  }
  return n;
}

// 1 以上の整数を要求する版（PORT、QUERY_CONCURRENCY など）。
function envPositiveInt(env: Env, key: string, fallback: number): number {
  return envInt(env, key, fallback, 1);
}

// 0 以上の整数を要求する版（0 = 無制限/無効の意味を持つ設定向け）。
function envNonNegativeInt(env: Env, key: string, fallback: number): number {
  return envInt(env, key, fallback, 0);
}

// JavaScript の timer と PostgreSQL の timeout parameter が安全に扱える範囲で、
// ミリ秒の期限値を厳密な十進整数として読む。
function envTimeoutMs(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim();
  if (!/^\d+$/.test(normalized)) {
    throw new Error(`Invalid timeout for env var ${key}: ${JSON.stringify(raw)}`);
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new Error(
      `Invalid timeout for env var ${key}: ${JSON.stringify(raw)} ` +
        '(expected integer milliseconds between 1 and 2147483647)',
    );
  }
  return value;
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
    return {
      kind: 'postgres',
      url,
      timeouts: {
        connectionMs: envTimeoutMs(
          env,
          'DATABASE_CONNECT_TIMEOUT_MS',
          DEFAULT_POSTGRES_TIMEOUTS.connectionMs,
        ),
        statementMs: envTimeoutMs(
          env,
          'DATABASE_STATEMENT_TIMEOUT_MS',
          DEFAULT_POSTGRES_TIMEOUTS.statementMs,
        ),
        lockMs: envTimeoutMs(env, 'DATABASE_LOCK_TIMEOUT_MS', DEFAULT_POSTGRES_TIMEOUTS.lockMs),
        idleTransactionMs: envTimeoutMs(
          env,
          'DATABASE_IDLE_TX_TIMEOUT_MS',
          DEFAULT_POSTGRES_TIMEOUTS.idleTransactionMs,
        ),
        transactionMs: envTimeoutMs(
          env,
          'DATABASE_TRANSACTION_TIMEOUT_MS',
          DEFAULT_POSTGRES_TIMEOUTS.transactionMs,
        ),
      },
    };
  }
  // DATABASE_URL 未設定時は歴史的デフォルトである SQLite を使う。
  return { kind: 'sqlite', path: envStr(env, 'DB_PATH', './data/hubble.db') };
}

/** RESULT_STORE 関連の環境変数を解決する。 */
export function resolveResultStoreConfig(env: Env): ResultStoreConfig {
  const kind = envEnum(env, 'RESULT_STORE', ['none', 's3'] as const, 'none');
  const ttlDays = envPositiveInt(env, 'RESULT_STORE_TTL_DAYS', 7);
  if (kind === 'none') return { kind, ttlDays };

  const bucket = envOptional(env, 'RESULT_STORE_S3_BUCKET');
  if (bucket === undefined) {
    throw new Error('RESULT_STORE_S3_BUCKET is required when RESULT_STORE=s3');
  }
  return {
    kind,
    bucket,
    prefix: envStr(env, 'RESULT_STORE_S3_PREFIX', 'hubble-results/'),
    region: envOptional(env, 'RESULT_STORE_S3_REGION'),
    endpoint: envOptional(env, 'RESULT_STORE_S3_ENDPOINT'),
    ttlDays,
  };
}

/** GITHUB_* 関連の環境変数を解決する。 */
export function resolveGithubConfig(env: Env): GithubConfig {
  const repo = envOptional(env, 'GITHUB_REPO');
  const governance = envEnum(env, 'GITHUB_GOVERNANCE', ['off', 'on'] as const, 'off');
  const defaultBranch = envStr(env, 'GITHUB_DEFAULT_BRANCH', 'main');
  const statusTtlSeconds = envPositiveInt(env, 'GITHUB_STATUS_TTL_SECONDS', 120);

  if (repo === undefined) {
    return {
      enabled: false,
      defaultBranch,
      governance,
      statusTtlSeconds,
      syncCron: null,
    };
  }

  const ownerRepo = /^[^/]+\/[^/]+$/.test(repo);
  if (!ownerRepo) {
    throw new Error(`Invalid GITHUB_REPO: ${JSON.stringify(repo)} (expected owner/repo format)`);
  }

  const clientId = envOptional(env, 'GITHUB_APP_CLIENT_ID');
  const clientSecret = envOptional(env, 'GITHUB_APP_CLIENT_SECRET');
  if (clientId === undefined || clientSecret === undefined) {
    throw new Error(
      'GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET are required when GITHUB_REPO is set',
    );
  }

  const keyRaw = envOptional(env, 'GITHUB_TOKEN_ENCRYPTION_KEY');
  if (keyRaw === undefined) {
    throw new Error('GITHUB_TOKEN_ENCRYPTION_KEY is required when GITHUB_REPO is set');
  }
  const tokenEncryptionKey = parseGithubTokenKey(keyRaw, 'GITHUB_TOKEN_ENCRYPTION_KEY');
  const activeKeyId = envStr(env, 'GITHUB_TOKEN_ENCRYPTION_KEY_ID', 'default').trim();
  assertGithubKeyId(activeKeyId, 'GITHUB_TOKEN_ENCRYPTION_KEY_ID');
  const tokenKeys = new Map<string, Buffer>([[activeKeyId, tokenEncryptionKey]]);
  const keyringRaw = envOptional(env, 'GITHUB_TOKEN_ENCRYPTION_KEYRING');
  if (keyringRaw !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(keyringRaw);
    } catch {
      throw new Error('Invalid GITHUB_TOKEN_ENCRYPTION_KEYRING: expected a JSON object');
    }
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
      throw new Error('Invalid GITHUB_TOKEN_ENCRYPTION_KEYRING: expected a JSON object');
    }
    for (const [keyId, raw] of Object.entries(parsed)) {
      assertGithubKeyId(keyId, 'GITHUB_TOKEN_ENCRYPTION_KEYRING');
      if (typeof raw !== 'string') {
        throw new Error(`Invalid GITHUB_TOKEN_ENCRYPTION_KEYRING key '${keyId}': expected base64`);
      }
      const key = parseGithubTokenKey(raw, `GITHUB_TOKEN_ENCRYPTION_KEYRING key '${keyId}'`);
      const existing = tokenKeys.get(keyId);
      if (existing && !existing.equals(key)) {
        throw new Error(
          `Invalid GITHUB_TOKEN_ENCRYPTION_KEYRING: active key ID '${keyId}' has a different key`,
        );
      }
      tokenKeys.set(keyId, key);
    }
  }

  const syncCronRaw = envStr(env, 'GITHUB_SYNC_CRON', '0 3 * * *').trim();
  let syncCron: string | null;
  if (syncCronRaw.toLowerCase() === 'off') {
    syncCron = null;
  } else if (!isValidCron(syncCronRaw)) {
    throw new Error(
      `Invalid GITHUB_SYNC_CRON: ${JSON.stringify(syncCronRaw)} (expected 5-field cron or off)`,
    );
  } else {
    syncCron = syncCronRaw;
  }
  const syncToken = envOptional(env, 'GITHUB_SYNC_TOKEN');

  return {
    enabled: true,
    repo,
    defaultBranch,
    clientId,
    clientSecret,
    tokenEncryptionKey,
    tokenEncryptionKeys: { activeKeyId, keys: tokenKeys },
    governance,
    statusTtlSeconds,
    syncCron,
    ...(syncToken !== undefined ? { syncToken } : {}),
  };
}

function parseGithubTokenKey(raw: string, label: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`Invalid ${label}: decoded length is ${key.length}, expected 32 bytes`);
  }
  return key;
}

function assertGithubKeyId(keyId: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(keyId)) {
    throw new Error(`Invalid ${label}: key ID must match [A-Za-z0-9_-]{1,64}`);
  }
}

/** AI_* 関連の環境変数を解決する。 */
export function resolveAiConfig(env: Env): AiConfig {
  const provider = envEnum(
    env,
    'AI_PROVIDER',
    ['off', 'gemini-api', 'github-models'] as const,
    'off',
  );
  if (provider === 'off') {
    return { provider: 'off' };
  }

  const defaultModel = provider === 'gemini-api' ? 'gemini-2.5-flash' : 'openai/gpt-4o-mini';
  const defaultApiKeyEnv = provider === 'gemini-api' ? 'GEMINI_API_KEY' : 'GITHUB_MODELS_TOKEN';
  const model = envStr(env, 'AI_MODEL', defaultModel);
  const apiKeyEnv = envStr(env, 'AI_API_KEY_ENV', defaultApiKeyEnv);
  const apiKey = envOptional(env, apiKeyEnv);
  if (apiKey === undefined) {
    throw new Error(`${apiKeyEnv} is required when AI_PROVIDER=${provider}`);
  }
  const timeoutMs = envPositiveInt(env, 'AI_TIMEOUT_MS', 60_000);
  const maxConcurrency = envPositiveInt(env, 'AI_MAX_CONCURRENCY', 4);
  const perPrincipalPerMinute = envPositiveInt(env, 'AI_RATE_LIMIT_PER_MINUTE', 20);
  const maxResponseBytes = envPositiveInt(env, 'AI_MAX_RESPONSE_BYTES', 262_144);
  const maxOutputTokens = envPositiveInt(env, 'AI_MAX_OUTPUT_TOKENS', 2_048);
  return {
    provider,
    model,
    apiKey,
    timeoutMs,
    maxConcurrency,
    perPrincipalPerMinute,
    maxResponseBytes,
    maxOutputTokens,
  };
}

/** EXPORT_* 関連の環境変数を解決する。 */
export function resolveExportConfig(env: Env): ExportConfig {
  return {
    s3: {
      bucket: envOptional(env, 'EXPORT_S3_BUCKET'),
      prefix: envStr(env, 'EXPORT_S3_PREFIX', 'hubble-exports/'),
      region: envOptional(env, 'EXPORT_S3_REGION'),
      endpoint: envOptional(env, 'EXPORT_S3_ENDPOINT'),
    },
    sheets: {
      credentialsFile: envOptional(env, 'EXPORT_SHEETS_CREDENTIALS_FILE'),
    },
  };
}

/**
 * 日本語: 環境変数（既定は `process.env`、テストでは任意のオブジェクトを注入可能）から
 * `ServerConfig` を組み立てるエントリーポイント。各セクション（auth/trino/defaults/
 * query/metadata/guard/scheduler）ごとに対応する環境変数を読み、上の `env*` ヘルパーで
 * 型変換、デフォルト適用、不正値検出を行う。
 */
export function loadServerConfig(env: Env = process.env): ServerConfig {
  const smtpPasswordEnv = envOptional(env, 'NOTIFY_SMTP_PASSWORD_ENV');
  return {
    port: envPositiveInt(env, 'PORT', 8080),
    shutdownTimeoutMs: envPositiveInt(env, 'SHUTDOWN_TIMEOUT_MS', 60_000),
    http: {
      maxBodyBytes: envPositiveInt(env, 'HTTP_MAX_BODY_BYTES', 2_097_152),
    },
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
      user: envStr(env, 'TRINO_USER', 'admin'),
    },
    datasourceProbeTimeoutMs: envPositiveInt(env, 'DATASOURCE_PROBE_TIMEOUT_MS', 5000),
    defaults: {
      catalog: envOptional(env, 'DEFAULT_CATALOG'),
      schema: envOptional(env, 'DEFAULT_SCHEMA'),
      limit: envPositiveInt(env, 'DEFAULT_LIMIT', 5000),
    },
    query: {
      maxRows: envPositiveInt(env, 'QUERY_MAX_ROWS', 100_000),
      concurrency: envPositiveInt(env, 'QUERY_CONCURRENCY', 5),
      maxQueued: envPositiveInt(env, 'QUERY_MAX_QUEUED', 100),
      maxQueuedPerPrincipal: envPositiveInt(env, 'QUERY_MAX_QUEUED_PER_PRINCIPAL', 20),
      maxTracked: envPositiveInt(env, 'QUERY_MAX_TRACKED', 10_000),
      ttlMinutes: envPositiveInt(env, 'QUERY_TTL_MINUTES', 30),
      overflowMode: envEnum(
        env,
        'QUERY_OVERFLOW_MODE',
        ['truncate', 'cancel'] as const,
        'truncate',
      ),
    },
    metadata: {
      ttlSeconds: envPositiveInt(env, 'METADATA_TTL_SECONDS', 300),
    },
    resultStore: resolveResultStoreConfig(env),
    export: resolveExportConfig(env),
    guard: {
      mode: envEnum(env, 'QUERY_GUARD_MODE', ['off', 'warn', 'enforce'] as const, 'warn'),
      maxScanBytes: envNonNegativeInt(env, 'QUERY_GUARD_MAX_SCAN_BYTES', 0),
      maxScanRows: envNonNegativeInt(env, 'QUERY_GUARD_MAX_SCAN_ROWS', 0),
      onUnknown: envEnum(
        env,
        'QUERY_GUARD_ON_UNKNOWN',
        ['allow', 'warn', 'block'] as const,
        'warn',
      ),
      estimateTimeoutMs: envPositiveInt(env, 'QUERY_GUARD_ESTIMATE_TIMEOUT_MS', 3000),
      cacheTtlSeconds: envNonNegativeInt(env, 'QUERY_GUARD_CACHE_TTL_SECONDS', 30),
      bytesPerSecond: envNonNegativeInt(env, 'QUERY_GUARD_BYTES_PER_SECOND', 0),
    },
    scheduler: {
      enabled: envBool(env, 'SCHEDULER_ENABLED', true),
      tickSeconds: envPositiveInt(env, 'SCHEDULER_TICK_SECONDS', 15),
      maxConcurrent: envPositiveInt(env, 'SCHEDULER_MAX_CONCURRENT', 2),
      runsRetention: envPositiveInt(env, 'SCHEDULER_RUNS_RETENTION', 50),
    },
    notification: {
      slackWebhookUrl: envOptional(env, 'NOTIFY_SLACK_WEBHOOK_URL'),
      webhookAllowedCidrs: parseCidrList(envStr(env, 'NOTIFY_WEBHOOK_ALLOWED_CIDRS', '')),
      webhookAllowHttp: envBool(env, 'NOTIFY_WEBHOOK_ALLOW_HTTP', false),
      webhookTimeoutMs: envPositiveInt(env, 'NOTIFY_WEBHOOK_TIMEOUT_MS', 10_000),
      channelTimeoutMs: envPositiveInt(env, 'NOTIFY_CHANNEL_TIMEOUT_MS', 10_000),
      smtp: {
        host: envOptional(env, 'NOTIFY_SMTP_HOST'),
        port: envPositiveInt(env, 'NOTIFY_SMTP_PORT', 587),
        user: envOptional(env, 'NOTIFY_SMTP_USER'),
        password: smtpPasswordEnv ? envOptional(env, smtpPasswordEnv) : undefined,
        from: envOptional(env, 'NOTIFY_SMTP_FROM'),
      },
    },
    alertDelivery: {
      intervalMs: envPositiveInt(env, 'ALERT_DELIVERY_INTERVAL_MS', 5_000),
      maxAttempts: envPositiveInt(env, 'ALERT_DELIVERY_MAX_ATTEMPTS', 5),
      backoffMs: envPositiveInt(env, 'ALERT_DELIVERY_BACKOFF_MS', 10_000),
    },
    dataRetention: {
      alertDeliveryDays: envNonNegativeInt(env, 'ALERT_DELIVERY_RETENTION_DAYS', 30),
      queryHistoryDays: envNonNegativeInt(env, 'QUERY_HISTORY_RETENTION_DAYS', 90),
      auditLogDays: envNonNegativeInt(env, 'AUDIT_LOG_RETENTION_DAYS', 365),
      batchSize: envPositiveInt(env, 'DATA_RETENTION_BATCH_SIZE', 500),
    },
    github: resolveGithubConfig(env),
    ai: resolveAiConfig(env),
    version: envStr(env, 'APP_VERSION', '0.1.0'),
  };
}

/**
 * Build the public `AppConfig` from server config and validate it
 * against the contract before exposing it via `GET /api/config`.
 *
 * 日本語: `ServerConfig`（内部設定）と既定データソースから、フロントエンドに
 * 公開してよい部分だけを抜き出し、`GET /api/config` で返す `AppConfig`
 * （packages/contracts の契約スキーマ）を組み立てる。`appConfigSchema.parse`
 * によって契約に沿った形になっているかをここで検証する（サーバー起動直後の
 * 設定ミスをテスト/起動時に検出できるようにするため）。
 *
 * `datasources.yaml` の必須化により、Trino 接続先 URL は `config.trino`（横断設定、
 * user のみ）ではなく既定データソース自体が一次情報源になった。既定データソースが
 * Trino でない場合(例: MySQL/PostgreSQL を既定にした構成)は、契約上 URL 必須の
 * ため意味のあるプレースホルダーを返す(web 側は現状この値を表示に使っていない)。
 *
 * @param config - サーバー内部設定。
 * @param defaultDatasource - 既定データソース(未解決/非 Trino の場合は省略可)。
 * @returns 契約スキーマで検証済みの公開設定。
 */
export function toAppConfig(
  config: ServerConfig,
  defaultDatasource?: ResolvedDatasource,
): AppConfig {
  const trinoUrl =
    defaultDatasource !== undefined && defaultDatasource.type === 'trino'
      ? defaultDatasource.baseUrl
      : 'http://localhost';
  return appConfigSchema.parse({
    trino: {
      url: trinoUrl,
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
    ai:
      config.ai.provider === 'off'
        ? { enabled: false, provider: 'off' }
        : { enabled: true, provider: config.ai.provider, model: config.ai.model },
    version: config.version,
  });
}

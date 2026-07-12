/**
 * hubble server の中核: Hono アプリ本体の組み立てを担当するファイル。
 *
 * `index.ts`（プロセス起動）と `test/harness.ts`（テスト起動）の双方から呼ばれる
 * 共通の初期化ロジックを提供する。責務は大きく2つ:
 * - `defaultServices()`: 環境変数から設定を読み込み、DB を開いてマイグレーションを適用し、
 *   Services グラフ（Trino クライアント、各リポジトリ、スケジューラー等）を構築する
 * - `createApp()`: healthz → 認証ミドルウェア → 各ドメインルーター → 404 → 静的配信 →
 *   エラーハンドラ、という順序で Hono のルーティングを一括登録する
 *
 * アーキテクチャ上の位置づけ: packages/contracts の zod スキーマ（API 契約）に基づき、
 * 各 http/*Routes.ts をここでマウントする「配線」の役割。ビジネスロジック自体は
 * 各ルーター/サービス側にあり、このファイルはそれらを正しい順序で組み合わせるだけに留める。
 */
import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { apiRoutes, meResponseSchema, type MeResponse } from '@hubble/contracts';
import { loadServerConfig, toAppConfig } from './config';
import { openDatabase } from './db';
import { buildServices, type BuildServicesOptions, type Services } from './services';
import { AppError, toErrorResponse } from './errors';
import { authMiddleware, type AuthVariables, type RemoteAddressFn } from './auth/middleware';
import { datasourceRoutes } from './http/datasourceRoutes';
import { datasourceMetadataRoutes, metadataRoutes } from './http/metadataRoutes';
import { queryRoutes } from './http/queryRoutes';
import { historyRoutes, notebookRoutes, savedQueryRoutes } from './http/storeRoutes';
import { scheduleRoutes } from './http/scheduleRoutes';
import { alertRoutes } from './http/alertRoutes';
import { dashboardRoutes } from './http/dashboardRoutes';
import { workflowRoutes, workflowRunRoutes } from './http/workflowRoutes';
import { githubRoutes } from './http/githubRoutes';
import { adminRoutes } from './http/adminRoutes';
import { aiRoutes } from './http/aiRoutes';
import { registerStaticServing } from './http/staticRoutes';
import { filterDatasourcesForRole } from './rbac/check';
import { toDatasourceSummaries } from './datasource/summary';

/** createApp に渡す依存関係。 */
export interface AppDeps {
  services: Services;
  /** Override the remote-address source for the auth middleware (tests). */
  /** 日本語: 認証ミドルウェアがリモートアドレスを取得する方法を差し替える（テスト用）。 */
  remoteAddress?: RemoteAddressFn;
  /** Google Sheets API client factory override (tests). */
  sheetsClientFactory?: import('./query/exportSheets').SheetsClientFactory;
}

// 画面埋め込み、MIME 推測、参照元送信、不要なブラウザー機能を全レスポンスで抑止する。
const RESPONSE_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
} as const;

// CSRF 判定の対象外とする副作用のない HTTP メソッド。
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** unsafe な API 要求が別 origin から届いた場合に 403 を生成する。 */
function crossSiteRequestError(): AppError {
  return AppError.forbidden('Cross-site request rejected', 'CSRF_REJECTED');
}

/**
 * Build the `Services` graph using the configured persistence backend and the
 * default (env-derived) config, applying migrations. Convenience for
 * `index.ts`.
 *
 * 日本語: 環境変数から `ServerConfig` を読み込み、設定された永続化バックエンド
 * （SQLite または PostgreSQL）で DB 接続を開いてマイグレーションを適用したうえで、
 * `buildServices` に委譲して Services グラフを構築する。`index.ts` から呼ばれる
 * 便利関数（本番起動用のデフォルト経路）。
 */
export async function defaultServices(options: BuildServicesOptions = {}): Promise<Services> {
  const config = loadServerConfig();
  const db = await openDatabase(config.database);
  return buildServices(config, db, options);
}

/**
 * Build the Hono app wiring every API route. All handlers throw
 * `AppError` on failure; the error handler renders the `{ error }` envelope.
 *
 * 日本語: 全 API エンドポイントを配線した Hono アプリを構築する。
 * 各ハンドラは失敗時に `AppError` を throw する規約になっており、末尾の
 * `app.onError` が一律に `{ error: {...} }` 形式のレスポンスへ変換する。
 */
export function createApp(deps: AppDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const { services } = deps;

  // API、静的ファイル、エラー応答を含む全レスポンスへ同じ防御ヘッダーを付ける。
  app.use('*', async (c, next) => {
    await next();
    for (const [name, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) {
      c.header(name, value);
    }
  });

  // unsafe method は Fetch Metadata と Origin で同一 origin からの要求に限定する。
  // 両ヘッダーを送らない古い利用者エージェントは互換性のため従来どおり許可する。
  app.use('/api/*', async (c, next) => {
    if (!CSRF_SAFE_METHODS.has(c.req.method.toUpperCase())) {
      const fetchSite = c.req.header('Sec-Fetch-Site')?.toLowerCase();
      if (fetchSite === 'cross-site') throw crossSiteRequestError();

      const origin = c.req.header('Origin');
      if (origin !== undefined) {
        let suppliedHost: string;
        try {
          suppliedHost = new URL(origin).host;
        } catch {
          throw crossSiteRequestError();
        }
        // TLS 終端プロキシでは browser の Origin が https、upstream URL が http になるため、
        // scheme ではなく port を含む host が一致することを同一サイトの条件にする。
        if (suppliedHost !== new URL(c.req.url).host) throw crossSiteRequestError();
      }
    }
    await next();
  });

  // JSON parse より前に raw body を制限し、巨大入力を heap へ展開しない。
  app.use(
    '/api/*',
    bodyLimit({
      maxSize: services.config.http.maxBodyBytes,
      onError: () => {
        throw new AppError(413, {
          code: 'PAYLOAD_TOO_LARGE',
          message: `Request body exceeds ${services.config.http.maxBodyBytes} bytes`,
        });
      },
    }),
  );

  // healthz and readyz are always public: they must answer before auth.
  // 日本語: liveness と readiness は認証ミドルウェアより前に登録し、常に認証不要で
  // 応答させる（ロードバランサ等の監視が認証設定に左右されないようにするため）。
  app.get(apiRoutes.healthz(), (c) => c.json({ status: 'ok' }));

  // readiness は DB と既定エンジンを短い期限で確認し、受付不能なら 503 を返す。
  app.get(apiRoutes.readyz(), async (c) => {
    const result = await services.readiness.check();
    const body = {
      status: result.ready ? ('ok' as const) : ('unavailable' as const),
      checks: result.checks,
    };
    return result.ready ? c.json(body) : c.json(body, 503);
  });

  // Authentication gate for every other /api route. In `none`
  // mode it transparently sets the technical principal; in `proxy` mode it
  // resolves the SSO principal or returns 401 UNAUTHENTICATED.
  // 日本語: healthz と readyz 以外の全 /api ルートに適用される認証ゲート。AUTH_MODE=none
  // （既定）では設定済みの技術アカウント (TRINO_USER) をそのまま principal として
  // 設定し、AUTH_MODE=proxy では oauth2-proxy が付与する SSO ヘッダから principal を
  // 解決する（信頼できない場合は 401 UNAUTHENTICATED を返す）。
  app.use('/api/*', (c, next) =>
    authMiddleware({
      auth: services.config.auth,
      noneModeUser: services.config.trino.user,
      remoteAddress: deps.remoteAddress,
      getRbac: () => services.rbac,
    })(c, next),
  );

  // フロントエンドが起動時に読む公開設定（Trino URL/既定値/認証モード/Guard 設定等）。
  // Trino URL は datasources.yaml で定義された既定データソースが一次情報源のため、
  // ここで既定データソースを検索して toAppConfig に渡す。
  app.get(apiRoutes.config(), (c) => {
    const defaultDatasource = services.datasources.find(
      (ds) => ds.id === services.defaultDatasourceId,
    );
    return c.json(toAppConfig(services.config, defaultDatasource));
  });
  app.route('/api/datasources', datasourceRoutes(services));
  app.route('/api/datasources', datasourceMetadataRoutes(services));
  // 認証ミドルウェアが解決した principal をそのまま返すだけの薄いエンドポイント。
  // TopBar のユーザー表示や 401 時のフォールバック UI 判定に使われる。
  // groups は IdP 側のメンバーシップ情報であり、クライアントに露出する必要がないため
  // MeResponse には含めない（ロール解決にのみ利用する）。
  app.get(apiRoutes.me(), (c) => {
    const principal = c.var.principal;
    const me: MeResponse = {
      user: principal.user,
      authMode: services.config.auth.mode,
      storageScope: createHash('sha256').update(principal.user).digest('hex'),
      role: principal.role.name,
      permissions: [...principal.role.permissions].sort(),
      datasources: toDatasourceSummaries(
        filterDatasourcesForRole(services.datasources, principal.role),
      ),
      ...(principal.email ? { email: principal.email } : {}),
    };
    return c.json(meResponseSchema.parse(me));
  });

  // Mount domain routers. Order matters: more specific prefixes first.
  // 日本語: ドメインごとのルーターをマウントする。Hono は前方一致でマッチするため、
  // より具体的なプレフィックス（/api/queries 等）を先に、包括的な metadataRoutes
  // （/api 直下に catalogs/metadata を生やす）を最後に登録する。
  app.route('/api/admin', adminRoutes(services));
  app.route('/api/ai', aiRoutes(services));
  app.route('/api/queries', queryRoutes(services));
  app.route('/api/notebooks', notebookRoutes(services));
  app.route('/api/saved-queries', savedQueryRoutes(services));
  app.route('/api/history', historyRoutes(services));
  app.route('/api/schedules', scheduleRoutes(services));
  app.route('/api/alerts', alertRoutes(services));
  app.route('/api/dashboards', dashboardRoutes(services));
  app.route('/api/workflows', workflowRoutes(services));
  app.route('/api/github', githubRoutes(services));
  app.route(
    '/api/workflow-runs',
    workflowRunRoutes(services, { sheetsClientFactory: deps.sheetsClientFactory }),
  );
  // Metadata router owns `/catalogs/...` and `/metadata/refresh` under `/api`.
  app.route('/api', metadataRoutes(services));

  // 404 for unknown /api routes (rendered as the error envelope below). This is
  // registered before static serving so an unknown `/api/*` path always yields
  // the JSON error envelope, never the SPA fallback below.
  // 日本語: 上記のどのドメインルーターにもマッチしなかった /api/* パスを 404 として
  // 明示的に扱う。静的配信 (SPA fallback) より前に登録することで、未知の API パスが
  // 誤って index.html を返してしまう事故を防ぐ。
  app.all('/api/*', () => {
    throw AppError.notFound('Not found');
  });

  // Static web app + SPA fallback. Only enabled when
  // STATIC_DIR is configured; never serves `/api/*` (handled above). Auth is
  // unaffected — assets are public and the middleware is mounted under `/api`.
  // 日本語: STATIC_DIR が設定されている場合のみ、ビルド済み web アプリを配信し、
  // 未知の非 /api パスは SPA のため index.html にフォールバックさせる。
  // 静的アセットは認証対象外（認証ミドルウェアは /api/* にのみ適用されている）。
  if (services.config.staticDir) {
    registerStaticServing(app, services.config.staticDir);
  }

  // Uniform error envelope.
  // 日本語: ルートハンドラ内で throw された全エラー（AppError / 想定外の例外）を
  // ここで一括捕捉し、`{ error: { code, message, ... } }` の統一フォーマットに変換する。
  app.onError(async (err, c) => {
    const { status, detail } = toErrorResponse(err);
    if (status === 403 && c.req.path.startsWith('/api/')) {
      const principal = c.var.principal;
      if (principal !== undefined) {
        await services.audit.record({
          actor: principal.user,
          action: 'authz.denied',
          target: c.req.path,
          detail: { method: c.req.method, errorCode: detail.code },
        });
      }
    }
    return c.json({ error: detail }, status as 400);
  });

  return app;
}

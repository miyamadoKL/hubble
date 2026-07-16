import type { Hono } from 'hono';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { onTestFinished } from 'vitest';
import type { SqlDatabase } from '../db/sqlDatabase';
import { loadServerConfig, type ServerConfig } from '../config';
import { buildServices, type Services } from '../services';
import { createApp } from '../app';
import type { AuthVariables, RemoteAddressFn } from '../auth/middleware';
import type { FakeScenario } from './fakeTrino';
import { FakeTrino } from './fakeTrino';
import { openTestDatabase } from './dbBackends';
import type { ResultStore } from '../resultStore';
import type { ResultStoreClock, ResultStoreObserver } from '../resultStore';
import type { AiProvider } from '../ai/provider';

/**
 * `datasources.yaml` が必須化されたことに伴うテストヘルパー。
 *
 * 呼び出し元が `env.DATASOURCES_PATH` を指定していない場合、実際に使う
 * 作業ディレクトリ(`cwd` が省略されていれば使い捨ての一時ディレクトリを新規作成)
 * 直下に `./datasources.yaml` が無ければ、fake Trino (`http://trino.test`) 1 件
 * だけを持つ使い捨ての YAML を書き出す。これにより、個々の `*Routes.test.ts` や
 * rbac 関連テスト等が明示的な datasources.yaml を用意しなくても、従来の
 * `trino-default` 後方互換フォールバックと同じ「単一 Trino データソース」構成で
 * 動作し続けられる。呼び出し元が既に同じ場所へ独自の datasources.yaml を
 * 書いている場合はそれを優先し、上書きしない。
 *
 * @param cwd - 呼び出し元が明示した作業ディレクトリ。
 * @param env - 呼び出し元が明示した環境変数。
 * @returns 実際に使う作業ディレクトリ。
 */
function resolveTestDatasourcesCwd(
  cwd: string | undefined,
  env: Record<string, string | undefined> | undefined,
): string {
  const effectiveCwd = cwd ?? mkdtempSync(join(tmpdir(), 'hubble-test-ds-'));
  // DATASOURCES_PATH が明示されている場合は呼び出し元がファイル配置を管理するため、
  // ここでは何も書き出さない。
  if (env?.DATASOURCES_PATH !== undefined) return effectiveCwd;
  const defaultPath = join(effectiveCwd, 'datasources.yaml');
  if (!existsSync(defaultPath)) {
    writeFileSync(
      defaultPath,
      `datasources:
  - id: trino-default
    type: trino
    displayName: Trino
    username: admin
    baseUrl: http://trino.test
    source: hubble
`,
      'utf8',
    );
  }
  return effectiveCwd;
}

/** 通常の結合テストが使う unrestricted 相当の RBAC を明示的に用意する。 */
function ensureTestRbacFile(
  cwd: string,
  env: Record<string, string | undefined> | undefined,
): void {
  if (env?.RBAC_PATH !== undefined) return;
  const defaultPath = join(cwd, 'rbac.yaml');
  if (existsSync(defaultPath)) return;
  writeFileSync(
    defaultPath,
    [
      'roles:',
      '  unrestricted:',
      '    permissions: [query.write, ai.use]',
      "    datasources: ['*']",
      'assignments: []',
      'defaultRole: unrestricted',
      '',
    ].join('\n'),
    'utf8',
  );
}

/** 通常の API テストへ、ブラウザーと同じ同一 origin ヘッダーを補う。 */
function installSameOriginRequestDefaults(
  app: Hono<{ Variables: AuthVariables }>,
  enabled: boolean,
): void {
  if (!enabled) return;
  const request = app.request.bind(app);
  app.request = ((input: Request | string | URL, init?: RequestInit) => {
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return request(input, init);

    const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
    const path = new URL(url, 'http://hubble.example').pathname;
    if (!path.startsWith('/api/')) return request(input, init);

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    if (!headers.has('Origin') && !headers.has('Sec-Fetch-Site')) {
      headers.set('Origin', 'http://localhost');
      headers.set('Sec-Fetch-Site', 'same-origin');
      return request(input, { ...init, headers });
    }
    return request(input, init);
  }) as typeof app.request;
}

/**
 * server パッケージの結合テストで共通利用する「テストコンテキスト構築」を
 * 提供するファイル。テスト用DB + `FakeTrino` (fakeTrino.ts) を使い、
 * 実Trinoを起動せずに `createApp()` で組み立てた完全な Hono アプリを
 * 得られるようにする。ルートハンドラの結合テスト (app.test.ts,
 * *Routes.test.ts 等) はほぼ全てこの `createTestContext` を起点にしている。
 */

/** `createTestContext` が返す、テストから触るための一式。 */
export interface TestContext {
  app: Hono<{ Variables: AuthVariables }>;
  services: Services;
  fake: FakeTrino;
  /** リポジトリ層を直接触るテスト用 (通常のルートテストでは使わない)。 */
  db: SqlDatabase;
}

/**
 * テスト用DBとfake Trinoで完全なアプリを構築する。
 * バックオフ待ちは即座に解決してテストを高速化する。
 *
 * 日本語: 実施内容は次の通り。
 *   1. `options.scenarios` を積んだ `FakeTrino` を生成する (Trino の代わり)。
 *   2. `loadServerConfig` で既定設定を読み込み、`options.configOverrides` で
 *      個別に上書きする。Trino 接続先(baseUrl)は datasources.yaml 側の責務に
 *      なったため、ここでは `resolveTestDatasourcesCwd` が fake サーバーの URL
 *      (`http://trino.test`) を指す使い捨て datasources.yaml を用意する。
 *      scheduler はデフォルトで tick ループを無効化する (`startScheduler` が
 *      true でない限り) ことで、ルート/CRUD テストが背後の非同期発火に
 *      影響されず決定的に動くようにする。
 *   3. config構築後に `options.databaseFactory` を呼び、未指定ならテスト用DBを
 *      開いて `buildServices` でサービス層一式を構築する。TEST_DATABASE_URL設定時
 *      はPostgreSQL、未設定時はSQLiteを開く。factoryが返したDBの所有権はServicesへ
 *      移り、`services.shutdown()` がDBを閉じる。
 *      `fetchImpl` は fake.fetch (実ネットワークなしで応答)、`sleepImpl`/
 *      `schedulerSleep` は既定で即座に resolve するダミーにして、バックオフ待ちの
 *      せいでテストが遅くならないようにする。
 *   4. `services.scheduler.start()` を呼んでおく (クラッシュ復旧処理は常に必要。
 *      tick ループ自体は enabled=false なら回らない)。
 *   5. `createApp()` で Hono アプリを組み立てて返す。
 */
export async function createTestContext(
  options: {
    scenarios?: FakeScenario[];
    configOverrides?: Partial<ServerConfig>;
    env?: Record<string, string | undefined>;
    /** config構築後にDBを開くfactory。未指定時はテスト用DBを開く。 */
    databaseFactory?: () => Promise<SqlDatabase>;
    /** Override backoff sleep (e.g. to record requested delays). Defaults to a no-op. */
    sleepImpl?: (ms: number) => Promise<void>;
    /** Override the peer address the auth middleware sees (proxy-mode tests). */
    remoteAddress?: RemoteAddressFn;
    /** Start the in-process scheduler tick loop (default: false, API only). */
    startScheduler?: boolean;
    /** スケジューラーと評価器が参照する現在時刻の差し替え（テスト用）。 */
    now?: () => number;
    /** datasources.yaml 探索の作業ディレクトリ（テスト用）。 */
    cwd?: string;
    reloadLogError?: (message: string, err: unknown) => void;
    reloadLogWarn?: (message: string) => void;
    resultStore?: ResultStore;
    resultStoreObserver?: ResultStoreObserver;
    resultStoreClock?: ResultStoreClock;
    resultStoreLogWarn?: (message: string, err?: unknown) => void;
    sheetsClientFactory?: import('../query/exportSheets').SheetsClientFactory;
    /** Override fetch for non-Trino HTTP (e.g. GitHub API). When set, used instead of fake.fetch. */
    fetchImpl?: typeof fetch;
    /** Inject a fake GitHub API client into GithubSyncService. */
    githubClient?: import('../github/client').GithubClient;
    /** テスト注入用の AI provider。 */
    aiProvider?: AiProvider;
    /** unsafe API の既定ヘッダーを無効化する直接 CSRF テスト向け設定。 */
    defaultSameOriginHeaders?: boolean;
  } = {},
): Promise<TestContext> {
  const fake = new FakeTrino(options.scenarios ?? []);
  const baseConfig = loadServerConfig(options.env ?? {});
  // 日本語: 各セクションごとにベース設定と configOverrides をマージする。
  // Trino 接続先(baseUrl)は datasources.yaml 側の責務になったため、ここでは
  // config.trino(横断設定、user のみ)への configOverrides.trino の上書きだけを行う。
  const config: ServerConfig = {
    ...baseConfig,
    ...options.configOverrides,
    http: { ...baseConfig.http, ...options.configOverrides?.http },
    trino: { ...baseConfig.trino, ...options.configOverrides?.trino },
    query: { ...baseConfig.query, ...options.configOverrides?.query },
    metadata: { ...baseConfig.metadata, ...options.configOverrides?.metadata },
    resultStore: options.configOverrides?.resultStore ?? baseConfig.resultStore,
    export: {
      ...baseConfig.export,
      ...options.configOverrides?.export,
      s3: { ...baseConfig.export.s3, ...options.configOverrides?.export?.s3 },
      sheets: { ...baseConfig.export.sheets, ...options.configOverrides?.export?.sheets },
    },
    defaults: { ...baseConfig.defaults, ...options.configOverrides?.defaults },
    guard: { ...baseConfig.guard, ...options.configOverrides?.guard },
    notification: {
      ...baseConfig.notification,
      ...options.configOverrides?.notification,
      smtp: {
        ...baseConfig.notification.smtp,
        ...options.configOverrides?.notification?.smtp,
      },
    },
    scheduler: {
      ...baseConfig.scheduler,
      // Default: tick loop off so route/CRUD tests are deterministic.
      // 日本語: startScheduler を明示的に true にしない限り、スケジューラーの
      // tick タイマーは起動しない。これにより時間経過に依存しないテストになる。
      enabled: options.startScheduler ?? false,
      ...options.configOverrides?.scheduler,
    },
    github: { ...baseConfig.github, ...options.configOverrides?.github },
    ai: options.configOverrides?.ai ?? baseConfig.ai,
  };

  const db = await (options.databaseFactory?.() ?? openTestDatabase());
  let services: Services | undefined;
  try {
    const cwd = resolveTestDatasourcesCwd(options.cwd, options.env);
    ensureTestRbacFile(cwd, options.env);
    services = await buildServices(config, db, {
      env: options.env,
      cwd,
      now: options.now,
      fetchImpl: options.fetchImpl ?? fake.fetch,
      githubClient: options.githubClient,
      // 日本語: 既定では待たずに即 resolve するので、バックオフ待ちが原因で
      // テストが遅くなることはない。実際の待ち時間を検証したいテストのみ
      // sleepImpl を渡して記録し、制御する。
      sleepImpl: options.sleepImpl ?? (() => Promise.resolve()),
      schedulerSleep: () => Promise.resolve(),
      reloadLogError: options.reloadLogError,
      reloadLogWarn: options.reloadLogWarn,
      resultStore: options.resultStore,
      resultStoreObserver: options.resultStoreObserver,
      resultStoreClock: options.resultStoreClock,
      resultStoreLogWarn: options.resultStoreLogWarn,
      resultCleanupSetTimer: () => ({ clear: () => {} }),
      aiProvider: options.aiProvider,
    });
    // 日本語: enabled=false でもクラッシュ復旧 (abortOrphans) は必ず走るため、
    // tick ループを使わないテストでも start() は呼んでおく必要がある。
    await services.scheduler.start();
    await services.alertEvaluator.start();
    await services.workflowRunner.start();
    const app = createApp({
      services,
      remoteAddress: options.remoteAddress,
      sheetsClientFactory: options.sheetsClientFactory,
    });
    installSameOriginRequestDefaults(app, options.defaultSameOriginHeaders ?? true);
    const originalShutdown = services.shutdown;
    let shutdownCalled = false;
    services.shutdown = () => {
      shutdownCalled = true;
      return originalShutdown();
    };
    // TestContextが保持するServicesの所有資源を、明示的なshutdownがない場合も
    // テスト終了時に解放する。明示呼出時は元の冪等処理を再利用して二重closeを防ぐ。
    onTestFinished(async () => {
      if (!shutdownCalled) await originalShutdown();
    });
    return { app, services, fake, db };
  } catch (error) {
    // DBを開いた後の構築失敗でも、Servicesの所有権移譲前ならここで閉じる。
    if (services === undefined) {
      await db.close().catch(() => undefined);
    } else {
      // Services構築後はshutdownにDBを含む全所有資源の解放を任せる。
      await services.shutdown().catch(() => undefined);
    }
    throw error;
  }
}

/** Poll until a query reaches a terminal state (test convenience). */
// 日本語: registry から実行中のクエリを取得し、その `settled` プロミスを待つ
// だけのヘルパー。ストリーミング実行の完了 (成功/失敗/キャンセル問わず) を
// テストコードから簡潔に待ち合わせるために使う。該当クエリが既に registry から
// 消えている (見つからない) 場合は何もせずそのまま返る。
export async function waitForTerminal(services: Services, queryId: string): Promise<void> {
  const exec = services.registry.get(queryId);
  if (!exec) return;
  await exec.settled;
}

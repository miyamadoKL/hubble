import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const e2eDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(e2eDir, '..');
const e2eRbacConfigPath = resolve(repoRoot, 'deploy/compose/rbac.yaml');
/** マルチデータソース E2E (datasources.spec.ts)。`MULTI_DS_E2E=1` で有効化。 */
const multiDsE2e = process.env.MULTI_DS_E2E === '1';
const multiDsConfigPath = resolve(e2eDir, 'datasources.e2e.yaml');

/**
 * サーバー本体は `datasources.yaml`(必須化済み)からしか Trino 接続先を
 * 読まなくなったため、単一データソース構成の E2E(デフォルトの P6 スイート)も
 * `DATASOURCES_PATH` 経由で YAML を渡す必要がある。`TRINO_BASE_URL` は
 * サーバーが直接読む環境変数ではなくなったので、E2E ハーネス専用であることが
 * 明確な `E2E_TRINO_BASE_URL` を使い、その値を埋め込んだ使い捨ての
 * datasources.yaml を一時ディレクトリに生成して `DATASOURCES_PATH` に渡す。
 *
 * @param baseUrl - 埋め込む Trino coordinator の URL。
 * @returns 生成した YAML の絶対パス。
 */
function writeSingleDatasourceYaml(baseUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'hubble-e2e-ds-'));
  const path = join(dir, 'datasources.yaml');
  writeFileSync(
    path,
    `datasources:
  - id: trino-default
    type: trino
    displayName: Trino
    username: admin
    baseUrl: ${baseUrl}
    source: hubble
`,
    'utf8',
  );
  return path;
}

/** E2E 専用: 単体 Trino に対する既定の接続先 URL(既定 http://127.0.0.1:30080)。 */
const e2eTrinoBaseUrl = process.env.E2E_TRINO_BASE_URL ?? 'http://127.0.0.1:30080';
const singleDsConfigPath = writeSingleDatasourceYaml(e2eTrinoBaseUrl);

const e2eDatabaseUrl = process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? '';
const e2eAuthDatabaseUrl = process.env.E2E_AUTH_DATABASE_URL ?? '';
if (e2eDatabaseUrl && e2eAuthDatabaseUrl && e2eDatabaseUrl === e2eAuthDatabaseUrl) {
  throw new Error('E2E_AUTH_DATABASE_URL must be different from the main E2E database URL');
}

/**
 * Playwright設定。BFFサーバー（ポート8081）とweb開発サーバー（ポート5173）を起動し、
 * 実際のTrino（tpchカタログ）に対してP6のE2Eスイートを実行する。スイートは
 * `E2E_TRINO_BASE_URL`（既定値 http://127.0.0.1:30080、ユーザーadmin、パスワード空文字）
 * に接続できることを前提とする。この値はE2Eハーネス専用で、テスト対象server用の
 * 使い捨て `datasources.yaml` の生成に使う（server本体は `TRINO_BASE_URL` を読まない）。
 *
 * 決定性と分離:
 *  - `E2E_DATABASE_URL` または `TEST_DATABASE_URL` で通常BFF専用のPostgreSQL DBを指定する。
 *  - `E2E_AUTH_DATABASE_URL` でproxy認証BFF専用の別PostgreSQL DBを指定する。2つのURLは一致させない。
 *  - `QUERY_MAX_ROWS=10000` でserver側の行バッファ上限を設定する。仮想スクロールのテストは
 *    上限未満の5000行、切り詰め警告のテストは上限超過の12000行を要求するため、別serverなしで
 *    警告を決定的に発生させられる。
 */
// web 開発サーバー（Vite）のポート番号。
const WEB_PORT = Number(process.env.CAPTURE_WEB_PORT ?? 5173);
// server の本番既定ポートは 8080。E2E は既定で 8081 を使い、撮影時は
// CAPTURE_SERVER_PORT で既存サービスと衝突しないポートへ切り替えられる。
const SERVER_PORT = Number(process.env.CAPTURE_SERVER_PORT ?? 8081);
const captureMode = process.env.CAPTURE === '1';
/**
 * `AUTH_MODE=proxy` で稼働する、別ポート上の2つ目のBFFサーバー。
 * `auth.spec.ts` はこのサーバーに対して SSO ヘッダーを注入した HTTP リクエストを
 * 直接送ることで認証フローを検証する。localhost は既定の信頼済み CIDR に
 * 含まれるため、実際の oauth2-proxy は不要。既定のブラウザテスト群は
 * 引き続き SERVER_PORT のnone認証モードサーバーを使う。
 */
const AUTH_SERVER_PORT = 8082;
const reuseExistingServer = !captureMode && !process.env.CI && !multiDsE2e;

export default defineConfig({
  // テストファイルの探索ルートディレクトリ。
  testDir: './tests',
  // `capture.spec.ts` is a screenshot tool (writes docs/screenshots), not an
  // assertion suite — run it on demand with `CAPTURE=1 playwright test capture.spec.ts`.
  // `capture.spec.ts` はスクリーンショットを docs/screenshots に書き出すツールであり、
  // アサーションを行う通常のテストスイートではない。通常実行時は除外し、
  // `CAPTURE=1 playwright test capture.spec.ts` のように明示指定した場合のみ走らせる。
  testIgnore: captureMode ? [] : '**/capture.spec.ts',
  // Real Trino is the bottleneck, not the browser. Run files in parallel but
  // keep a modest worker count so we don't thrash the coordinator.
  // ボトルネックはブラウザではなく実際の Trino クラスタなので、ファイル単位の
  // 完全並列実行は行わず、coordinator に負荷をかけすぎない程度の worker 数に抑える。
  fullyParallel: false,
  // capture は共有 DB を使うため直列化し、通常の E2E は CI 2、ローカル 4 worker とする。
  workers: captureMode ? 1 : process.env.CI ? 2 : 4,
  // CI では `test.only` の混入をエラーにする（うっかりコミットを防止）。
  forbidOnly: !!process.env.CI,
  // CI ではフレーキーな失敗を許容して 1 回だけ自動リトライする。
  retries: process.env.CI ? 1 : 0,
  // CI では GitHub Actions 向けレポーター、ローカルでは一覧表示レポーターを使う。
  reporter: process.env.CI ? 'github' : 'list',
  // 1 テストあたりのタイムアウト（ミリ秒）。
  timeout: 60_000,
  // expect() アサーションの既定タイムアウト（ミリ秒）。
  expect: { timeout: 15_000 },
  use: {
    // web 開発サーバーへの baseURL。
    baseURL: `http://localhost:${WEB_PORT}`,
    // 最初のリトライ時のみトレースを記録する（通常実行では記録しない）。
    trace: 'on-first-retry',
    // クリックなどの操作のタイムアウト（ミリ秒）。
    actionTimeout: 15_000,
    // ページ遷移のタイムアウト（ミリ秒）。
    navigationTimeout: 30_000,
  },
  projects: [
    {
      // Chromium（Desktop Chrome 相当）のみを対象にする。
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      // none 認証モードの通常 BFF サーバーを起動するコマンド。
      command: 'pnpm --filter @hubble/server dev',
      port: SERVER_PORT,
      cwd: '..',
      // 通常の E2E では既存サーバーを再利用する。撮影時とマルチデータソース時は
      // 設定とデータベースを隔離するため、必ず Playwright が起動したサーバーを使う。
      reuseExistingServer,
      // サーバー起動待ちのタイムアウト（ミリ秒）。
      timeout: 60_000,
      env: {
        PORT: String(SERVER_PORT),
        DATABASE_URL: e2eDatabaseUrl,
        // 結果行バッファの上限（切り詰めテストの決定性確保のため）。
        QUERY_MAX_ROWS: '10000',
        ...(multiDsE2e
          ? {
              DATASOURCES_PATH: multiDsConfigPath,
              DEMO_MYSQL_PASSWORD: process.env.DEMO_MYSQL_PASSWORD ?? 'hubble-demo',
              DEMO_POSTGRES_PASSWORD: process.env.DEMO_POSTGRES_PASSWORD ?? 'hubble-demo',
            }
          : { DATASOURCES_PATH: singleDsConfigPath }),
        RBAC_PATH: e2eRbacConfigPath,
        DEFAULT_CATALOG: 'tpch',
        DEFAULT_SCHEMA: 'tiny',
      },
    },
    ...(captureMode
      ? []
      : [
          {
            // auth.spec.ts 専用の proxy 認証モード BFF サーバー。接続先 Trino は共通だが、
            // DB とポートは通常サーバーと分離している。SSO ヘッダーはテスト側から注入する。
            command: 'pnpm --filter @hubble/server dev',
            port: AUTH_SERVER_PORT,
            cwd: '..',
            reuseExistingServer,
            timeout: 60_000,
            env: {
              PORT: String(AUTH_SERVER_PORT),
              AUTH_MODE: 'proxy',
              DATABASE_URL: e2eAuthDatabaseUrl,
              QUERY_MAX_ROWS: '10000',
              ...(multiDsE2e
                ? {
                    DATASOURCES_PATH: multiDsConfigPath,
                    DEMO_MYSQL_PASSWORD: process.env.DEMO_MYSQL_PASSWORD ?? 'hubble-demo',
                    DEMO_POSTGRES_PASSWORD: process.env.DEMO_POSTGRES_PASSWORD ?? 'hubble-demo',
                  }
                : { DATASOURCES_PATH: singleDsConfigPath }),
              RBAC_PATH: e2eRbacConfigPath,
              DEFAULT_CATALOG: 'tpch',
              DEFAULT_SCHEMA: 'tiny',
            },
          },
        ]),
    {
      // web の開発サーバー（Vite）を起動するコマンド。
      command: 'pnpm --filter @hubble/web dev',
      port: WEB_PORT,
      cwd: '..',
      reuseExistingServer,
      timeout: 60_000,
      // web の dev server 側のプロキシ先ポートを、通常 BFF サーバーに合わせる。
      env: {
        PORT: String(SERVER_PORT),
        WEB_PORT: String(WEB_PORT),
      },
    },
  ],
});

/** Base URL of the proxy-mode auth server (used by auth.spec.ts). */
// proxy 認証モードサーバーの baseURL（auth.spec.ts から参照される）。
export const AUTH_SERVER_URL = `http://localhost:${AUTH_SERVER_PORT}`;

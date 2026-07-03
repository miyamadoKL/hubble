import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const e2eDir = dirname(fileURLToPath(import.meta.url));
/** マルチデータソース E2E (datasources.spec.ts)。`MULTI_DS_E2E=1` で有効化。 */
const multiDsE2e = process.env.MULTI_DS_E2E === '1';
const multiDsConfigPath = resolve(e2eDir, 'datasources.e2e.yaml');

/**
 * Playwright config (design.md §3, §9). Starts the BFF server (port 8081) and the
 * web dev server (port 5173), then runs the P6 E2E suites against a real Trino
 * (tpch catalog, design.md §9). The suites assume a live Trino at
 * `TRINO_BASE_URL` (default http://127.0.0.1:30080, admin / empty password).
 *
 * Determinism + isolation:
 *  - `DB_PATH=:memory:` gives the server a throwaway SQLite — notebooks / saved
 *    queries / history created by tests never touch the developer's own DB.
 *  - `QUERY_MAX_ROWS=10000` bounds the server-side row buffer. The virtual-scroll
 *    test loads 5000 rows (under the cap), while the truncation test asks for
 *    12000 (over it) to drive the "result truncated" warning deterministically
 *    without a second server (design.md §5 truncated 警告).
 *
 * Hubble の E2E テスト (Playwright) 実行設定ファイル。
 * BFF server（ポート 8081）と web の開発サーバー（ポート 5173）を自動起動したうえで、
 * 実際に稼働している Trino（tpch カタログ）に対して P6 の E2E テスト群を実行する。
 * 各テストスイートは `TRINO_BASE_URL`（既定値 http://127.0.0.1:30080、
 * ユーザー admin / パスワード空文字）に生きた Trino が存在することを前提とする。
 *
 * 決定性と独立性の確保:
 *  - `DB_PATH=:memory:` により server にインメモリの使い捨て SQLite を与える。
 *    テストが作成するノートブック / 保存済みクエリ / 履歴が、開発者本人の
 *    実際の DB に影響を与えることは決してない。
 *  - `QUERY_MAX_ROWS=10000` で server 側の行バッファ上限を制御する。
 *    仮想スクロールのテストは上限未満の 5000 行を、切り詰め警告のテストは
 *    上限超過の 12000 行をそれぞれ要求することで、2 つ目の server を
 *    用意せずとも「結果が切り詰められた」警告を決定的に発生させられる
 *    （design.md §5 の truncated 警告）。
 */
// web 開発サーバー（Vite）のポート番号。
const WEB_PORT = 5173;
// The server's production default is 8080. E2E pins to 8081 to avoid
// conflicts with any process already bound to 8080 on this dev machine.
// server の本番既定ポートは 8080 だが、開発機で既に 8080 を使っている
// プロセスとの衝突を避けるため、E2E では 8081 に固定している。
const SERVER_PORT = 8081;
/**
 * A second BFF on a separate port running `AUTH_MODE=proxy` (design.md §11).
 * `auth.spec.ts` drives it directly over HTTP with injected SSO headers — no
 * real oauth2-proxy needed (localhost is inside the default trusted CIDR). The
 * default browser suite keeps using the none-mode server on SERVER_PORT.
 *
 * `AUTH_MODE=proxy` で稼働する、別ポート上の 2 つ目の BFF サーバー用ポート番号。
 * `auth.spec.ts` はこのサーバーに対して SSO ヘッダーを注入した HTTP リクエストを
 * 直接送ることで認証フローを検証する。localhost は既定の信頼済み CIDR に
 * 含まれるため、実際の oauth2-proxy は不要。既定のブラウザテスト群は
 * 引き続き none モードの SERVER_PORT のサーバーを使う。
 */
const AUTH_SERVER_PORT = 8082;

export default defineConfig({
  // テストファイルの探索ルートディレクトリ。
  testDir: './tests',
  // `capture.spec.ts` is a screenshot tool (writes docs/screenshots), not an
  // assertion suite — run it on demand with `CAPTURE=1 playwright test capture.spec.ts`.
  // `capture.spec.ts` はスクリーンショットを docs/screenshots に書き出すツールであり、
  // アサーションを行う通常のテストスイートではない。通常実行時は除外し、
  // `CAPTURE=1 playwright test capture.spec.ts` のように明示指定した場合のみ走らせる。
  testIgnore: process.env.CAPTURE ? [] : '**/capture.spec.ts',
  // Real Trino is the bottleneck, not the browser. Run files in parallel but
  // keep a modest worker count so we don't thrash the coordinator.
  // ボトルネックはブラウザではなく実際の Trino クラスタなので、ファイル単位の
  // 完全並列実行は行わず、coordinator に負荷をかけすぎない程度の worker 数に抑える。
  fullyParallel: false,
  // CI では 2、ローカルでは 4 の worker で実行する。
  workers: process.env.CI ? 2 : 4,
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
      // CI 以外では既存の起動済みサーバーを再利用する（起動時間短縮のため）。
      reuseExistingServer: !process.env.CI,
      // サーバー起動待ちのタイムアウト（ミリ秒）。
      timeout: 60_000,
      env: {
        PORT: String(SERVER_PORT),
        // インメモリ SQLite でテスト専用の使い捨て DB を使う。
        DB_PATH: ':memory:',
        // 結果行バッファの上限（切り詰めテストの決定性確保のため）。
        QUERY_MAX_ROWS: '10000',
        ...(multiDsE2e
          ? {
              DATASOURCES_PATH: multiDsConfigPath,
              DEMO_MYSQL_PASSWORD: process.env.DEMO_MYSQL_PASSWORD ?? 'hubble-demo',
              DEMO_POSTGRES_PASSWORD: process.env.DEMO_POSTGRES_PASSWORD ?? 'hubble-demo',
            }
          : {
              TRINO_BASE_URL: process.env.TRINO_BASE_URL ?? 'http://127.0.0.1:30080',
            }),
        DEFAULT_CATALOG: 'tpch',
        DEFAULT_SCHEMA: 'tiny',
      },
    },
    {
      // Proxy-mode BFF for auth.spec.ts (design.md §11). Same Trino, separate
      // DB + port; SSO headers are injected by the spec.
      // auth.spec.ts 専用の proxy 認証モード BFF サーバー。接続先 Trino は共通だが、
      // DB とポートは通常サーバーと分離している。SSO ヘッダーはテスト側から注入される。
      command: 'pnpm --filter @hubble/server dev',
      port: AUTH_SERVER_PORT,
      cwd: '..',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: String(AUTH_SERVER_PORT),
        AUTH_MODE: 'proxy',
        DB_PATH: ':memory:',
        QUERY_MAX_ROWS: '10000',
        ...(multiDsE2e
          ? {
              DATASOURCES_PATH: multiDsConfigPath,
              DEMO_MYSQL_PASSWORD: process.env.DEMO_MYSQL_PASSWORD ?? 'hubble-demo',
              DEMO_POSTGRES_PASSWORD: process.env.DEMO_POSTGRES_PASSWORD ?? 'hubble-demo',
            }
          : { TRINO_BASE_URL: process.env.TRINO_BASE_URL ?? 'http://127.0.0.1:30080' }),
        DEFAULT_CATALOG: 'tpch',
        DEFAULT_SCHEMA: 'tiny',
      },
    },
    {
      // web の開発サーバー（Vite）を起動するコマンド。
      command: 'pnpm --filter @hubble/web dev',
      port: WEB_PORT,
      cwd: '..',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // web の dev server 側のプロキシ先ポートを、通常 BFF サーバーに合わせる。
      env: { PORT: String(SERVER_PORT) },
    },
  ],
});

/** Base URL of the proxy-mode auth server (used by auth.spec.ts). */
// proxy 認証モードサーバーの baseURL（auth.spec.ts から参照される）。
export const AUTH_SERVER_URL = `http://localhost:${AUTH_SERVER_PORT}`;

import { defineConfig, devices } from '@playwright/test';

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
 */
const WEB_PORT = 5173;
// The server's production default is 8080. E2E pins to 8081 to avoid
// conflicts with any process already bound to 8080 on this dev machine.
const SERVER_PORT = 8081;
/**
 * A second BFF on a separate port running `AUTH_MODE=proxy` (design.md §11).
 * `auth.spec.ts` drives it directly over HTTP with injected SSO headers — no
 * real oauth2-proxy needed (localhost is inside the default trusted CIDR). The
 * default browser suite keeps using the none-mode server on SERVER_PORT.
 */
const AUTH_SERVER_PORT = 8082;

export default defineConfig({
  testDir: './tests',
  // `capture.spec.ts` is a screenshot tool (writes docs/screenshots), not an
  // assertion suite — run it on demand with `CAPTURE=1 playwright test capture.spec.ts`.
  testIgnore: process.env.CAPTURE ? [] : '**/capture.spec.ts',
  // Real Trino is the bottleneck, not the browser. Run files in parallel but
  // keep a modest worker count so we don't thrash the coordinator.
  fullyParallel: false,
  workers: process.env.CI ? 2 : 4,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @hubble/server dev',
      port: SERVER_PORT,
      cwd: '..',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: String(SERVER_PORT),
        DB_PATH: ':memory:',
        QUERY_MAX_ROWS: '10000',
        TRINO_BASE_URL: process.env.TRINO_BASE_URL ?? 'http://127.0.0.1:30080',
        DEFAULT_CATALOG: 'tpch',
        DEFAULT_SCHEMA: 'tiny',
      },
    },
    {
      // Proxy-mode BFF for auth.spec.ts (design.md §11). Same Trino, separate
      // DB + port; SSO headers are injected by the spec.
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
        TRINO_BASE_URL: process.env.TRINO_BASE_URL ?? 'http://127.0.0.1:30080',
        DEFAULT_CATALOG: 'tpch',
        DEFAULT_SCHEMA: 'tiny',
      },
    },
    {
      command: 'pnpm --filter @hubble/web dev',
      port: WEB_PORT,
      cwd: '..',
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: { PORT: String(SERVER_PORT) },
    },
  ],
});

/** Base URL of the proxy-mode auth server (used by auth.spec.ts). */
export const AUTH_SERVER_URL = `http://localhost:${AUTH_SERVER_PORT}`;

#!/usr/bin/env node
/**
 * Alert と Dashboard のスクリーンショットを撮影するスクリプト。
 *
 * - サーバー (packages/server) と web dev サーバー (vite) を自動起動し、
 *   撮影後に停止する (screenshots-workflow.mjs と同じ構成)。
 * - API でサンプルの保存済みクエリ、アラート、ダッシュボードを作成し、
 *   アラートは手動評価 (eval) で ok / triggered の状態を作ってから撮影する。
 * - 出力:
 *     docs/screenshots/dashboard-grid.png — ダッシュボードビュー (counter + チャート + テーブル)
 *     docs/screenshots/alerts-panel.png   — サイドバーの Alerts パネル (状態バッジ付き)
 *
 * 前提: localhost:8090 で Trino (tpch catalog) が稼働していること。
 * 実行: node e2e/screenshots-alerts-dashboards.mjs [webBaseURL]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = resolve(repoRoot, 'docs/screenshots');

const BASE_URL = process.argv[2] ?? 'http://localhost:5173';
// サーバーが待ち受けるポート。web dev サーバーの /api プロキシ先にもなる。
const SERVER_PORT = 8081;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const VIEWPORT = { width: 1440, height: 900 };

/**
 * コマンドをバックグラウンドで起動し、プロセスオブジェクトを返す。
 * detached で新しいプロセスグループを作り、停止時に pnpm 配下の子プロセスまで
 * まとめてシグナルを届けられるようにする。
 * @param cmd - 実行コマンド。
 * @param args - コマンド引数。
 * @param opts - spawn オプション。
 */
function runBg(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: 'inherit', detached: true, ...opts });
}

/**
 * runBg で起動したプロセスをプロセスグループごと停止する。
 * @param proc - runBg が返した ChildProcess。
 * @param signal - 送るシグナル。
 */
function killGroup(proc, signal) {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // 既にグループごと終了している場合は無視する
  }
}

/**
 * 指定 URL に対して定期的に fetch を試み、200 応答が返るまで待つ。
 * @param url - 待機対象の URL。
 * @param timeoutMs - タイムアウト (ms)。既定 60 秒。
 */
async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

/**
 * JSON ボディ付きの API 呼び出しを行い、失敗時はレスポンス本文込みで例外を投げる。
 * @param method - HTTP メソッド。
 * @param path - `/api/...` のパス。
 * @param body - JSON ボディ (省略可)。
 */
async function api(method, path, body) {
  const res = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} failed (${res.status}): ${text}`);
  }
  return res.json();
}

/**
 * サンプルの保存済みクエリを一括作成し、名前 → id のマップを返す。
 * すべて tpch.tiny を対象にした決定的なクエリで、counter / chart / table の
 * 各 widget 表示とアラート評価の両方に使う。
 */
async function createSavedQueries() {
  const defs = [
    {
      name: 'Total orders',
      description: 'Order count across all statuses.',
      statement: 'SELECT count(*) AS orders FROM tpch.tiny.orders',
    },
    {
      name: 'Total revenue (M$)',
      description: 'Lifetime revenue in millions of dollars.',
      statement: 'SELECT round(sum(totalprice) / 1e6, 1) AS revenue_musd FROM tpch.tiny.orders',
    },
    {
      name: 'Active customers',
      description: 'Registered customer count.',
      statement: 'SELECT count(*) AS customers FROM tpch.tiny.customer',
    },
    {
      name: 'Revenue by priority',
      description: 'Revenue grouped by order priority.',
      statement:
        'SELECT orderpriority, count(*) AS orders, round(sum(totalprice) / 1e6, 1) AS revenue_musd\nFROM tpch.tiny.orders\nGROUP BY orderpriority\nORDER BY orderpriority',
    },
    {
      name: 'Orders by region',
      description: 'Order count per customer region.',
      statement:
        'SELECT r.name AS region, count(*) AS orders\nFROM tpch.tiny.orders o\nJOIN tpch.tiny.customer c ON o.custkey = c.custkey\nJOIN tpch.tiny.nation n ON c.nationkey = n.nationkey\nJOIN tpch.tiny.region r ON n.regionkey = r.regionkey\nGROUP BY r.name\nORDER BY orders DESC',
    },
    {
      name: 'Top customers',
      description: 'Highest account balances.',
      statement:
        'SELECT c.name AS customer, n.name AS nation, c.acctbal\nFROM tpch.tiny.customer c\nJOIN tpch.tiny.nation n ON c.nationkey = n.nationkey\nORDER BY c.acctbal DESC\nLIMIT 50',
    },
    {
      name: 'Open orders',
      description: 'Orders still in the open state.',
      statement: "SELECT count(*) AS open_orders FROM tpch.tiny.orders WHERE orderstatus = 'O'",
    },
  ];
  const ids = new Map();
  for (const def of defs) {
    const created = await api('POST', '/api/saved-queries', {
      ...def,
      catalog: 'tpch',
      schema: 'tiny',
    });
    ids.set(def.name, created.id);
    console.log(`›   保存済みクエリ作成: ${def.name} (${created.id})`);
  }
  return ids;
}

/**
 * サンプルアラートを作成し、必要なものは手動評価して状態を作る。
 * @param savedIds - createSavedQueries が返した名前 → id のマップ。
 */
async function createAlerts(savedIds) {
  // triggered になるアラート: open orders (約 7,300 件) が 5,000 を超過。
  const backlog = await api('POST', '/api/alerts', {
    name: 'Open orders backlog',
    savedQueryId: savedIds.get('Open orders'),
    columnName: 'open_orders',
    op: '>',
    value: '5000',
    selector: 'first',
    rearm: 0,
    cron: '*/30 * * * *',
  });
  // ok になるアラート: 売上 (約 2,200 M$) は 100 M$ を下回らない。
  const floor = await api('POST', '/api/alerts', {
    name: 'Revenue floor',
    savedQueryId: savedIds.get('Total revenue (M$)'),
    columnName: 'revenue_musd',
    op: '<',
    value: '100',
    selector: 'first',
    rearm: 0,
    cron: '0 * * * *',
  });
  // Muted 表示を見せるアラート (評価せず unknown のまま)。
  await api('POST', '/api/alerts', {
    name: 'Nightly freshness check',
    savedQueryId: savedIds.get('Total orders'),
    columnName: 'orders',
    op: '==',
    value: '0',
    selector: 'first',
    rearm: 0,
    muted: true,
    cron: '0 6 * * *',
  });

  // 手動評価で state を確定させる (triggered と ok)。
  for (const alert of [backlog, floor]) {
    const result = await api('POST', `/api/alerts/${alert.id}/eval`);
    console.log(`›   アラート評価: ${alert.name} → ${result.state}`);
  }
}

/**
 * サンプルダッシュボード「Sales overview」を作成する。
 * 上段に counter 3 枚、中段に棒グラフと円グラフ、下段にテーブルを配置する。
 * @param savedIds - createSavedQueries が返した名前 → id のマップ。
 */
async function createDashboard(savedIds) {
  const widgets = [
    {
      id: 'w-orders',
      kind: 'query',
      position: { col: 0, row: 0, sizeX: 2, sizeY: 2 },
      savedQueryId: savedIds.get('Total orders'),
      viz: 'counter',
      counter: { columnIndex: 0, label: 'Total orders' },
      title: 'Orders',
    },
    {
      id: 'w-revenue',
      kind: 'query',
      position: { col: 2, row: 0, sizeX: 2, sizeY: 2 },
      savedQueryId: savedIds.get('Total revenue (M$)'),
      viz: 'counter',
      counter: { columnIndex: 0, label: 'Revenue (M$)' },
      title: 'Revenue',
    },
    {
      id: 'w-customers',
      kind: 'query',
      position: { col: 4, row: 0, sizeX: 2, sizeY: 2 },
      savedQueryId: savedIds.get('Active customers'),
      viz: 'counter',
      counter: { columnIndex: 0, label: 'Customers' },
      title: 'Customers',
    },
    {
      id: 'w-priority',
      kind: 'query',
      position: { col: 0, row: 2, sizeX: 3, sizeY: 3 },
      savedQueryId: savedIds.get('Revenue by priority'),
      viz: 'chart',
      chart: { type: 'bars', xIndex: 0, yIndices: [2], sort: 'none', limit: 'all' },
      title: 'Revenue by priority (M$)',
    },
    {
      id: 'w-region',
      kind: 'query',
      position: { col: 3, row: 2, sizeX: 3, sizeY: 3 },
      savedQueryId: savedIds.get('Orders by region'),
      viz: 'chart',
      chart: { type: 'pie', xIndex: 0, yIndices: [1], sort: 'desc', limit: 'all' },
      title: 'Orders by region',
    },
    {
      id: 'w-top-customers',
      kind: 'query',
      position: { col: 0, row: 5, sizeX: 6, sizeY: 3 },
      savedQueryId: savedIds.get('Top customers'),
      viz: 'table',
      title: 'Top customers by balance',
    },
  ];
  const dashboard = await api('POST', '/api/dashboards', {
    name: 'Sales overview',
    description: 'Orders, revenue, and customer KPIs from tpch.tiny.',
    widgets,
  });
  console.log(`›   ダッシュボード作成: ${dashboard.name} (${dashboard.id})`);
  return dashboard;
}

async function main() {
  await mkdir(outDir, { recursive: true });

  // 一時 datasources.yaml を生成する (localhost:8090 の Trino を指す)。
  const tmpDir = join(tmpdir(), `hubble-alert-dashboard-screenshot-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  const dsPath = join(tmpDir, 'datasources.yaml');
  await writeFile(
    dsPath,
    `datasources:\n  - id: trino-local\n    type: trino\n    displayName: Local Trino\n    username: admin\n    baseUrl: http://localhost:8090\n`,
    'utf8',
  );

  // サーバー起動。widget 6 枚が同時にクエリを投げるため QUERY_CONCURRENCY を広げる。
  console.log('› サーバーを起動しています…');
  const serverProc = runBg('pnpm', ['--filter', '@hubble/server', 'start'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      DB_PATH: ':memory:',
      DATASOURCES_PATH: dsPath,
      DEFAULT_CATALOG: 'tpch',
      DEFAULT_SCHEMA: 'tiny',
      QUERY_CONCURRENCY: '20',
    },
  });

  // web dev サーバー起動 (Vite の /api プロキシ先を SERVER_PORT に設定)。
  console.log('› web dev サーバーを起動しています…');
  const webProc = runBg('pnpm', ['--filter', '@hubble/web', 'dev'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
    },
  });

  let browser;
  try {
    console.log('› サーバーの起動を待っています…');
    await Promise.all([waitForServer(`${SERVER_URL}/api/datasources`), waitForServer(BASE_URL)]);
    console.log('› 両サーバーが起動しました。');

    // サンプルデータを API で作成する。
    console.log('› サンプルデータを作成しています…');
    const savedIds = await createSavedQueries();
    await createAlerts(savedIds);
    await createDashboard(savedIds);

    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const page = await context.newPage();

    // ライトテーマ、Data タブで起動する (アクティブタブの再クリックによる
    // サイドバー折りたたみを避けるため、目的のタブは後からクリックする)。
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      /* eslint-disable no-undef */
      document.documentElement.setAttribute('data-theme', 'light');
      window.localStorage.setItem(
        'hubble-ui',
        JSON.stringify({
          state: {
            theme: 'light',
            sidebarTab: 'data',
            sidebarWidth: 288,
            sidebarCollapsed: false,
          },
          version: 0,
        }),
      );
      /* eslint-enable no-undef */
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    // --- (1) ダッシュボードビュー ---
    console.log('› Dashboards パネルを開いています…');
    const dashboardsRailBtn = page.getByRole('button', { name: 'Dashboards', exact: true }).first();
    await dashboardsRailBtn.waitFor({ timeout: 10_000 });
    await dashboardsRailBtn.click();
    await page.waitForTimeout(400);

    const dashboardRow = page.locator('button', { hasText: 'Sales overview' }).first();
    await dashboardRow.waitFor({ timeout: 20_000 });
    await dashboardRow.click();

    // counter の値 (orders = 15,000) と ECharts のキャンバス 2 枚が
    // 描画されるまで待つことで、全 widget の実行完了を確認する。
    console.log('› widget の描画を待っています…');
    await page.locator('text=15,000').first().waitFor({ timeout: 60_000 });
    await page.locator('canvas').nth(1).waitFor({ timeout: 60_000 });
    // テーブル widget の行が描画されるまで待つ。
    await page.locator('text=Customer#').first().waitFor({ timeout: 60_000 });
    // チャートのアニメーション完了を待つ。
    await page.waitForTimeout(1500);

    console.log('› dashboard-grid.png を撮影しています…');
    await page.screenshot({ path: resolve(outDir, 'dashboard-grid.png') });

    // --- (2) Alerts パネル ---
    // サイドバーだけ Alerts に切り替える。メインエリアはダッシュボードのまま。
    console.log('› Alerts パネルを開いています…');
    const alertsRailBtn = page.getByRole('button', { name: 'Alerts', exact: true }).first();
    await alertsRailBtn.click();

    // 3 件のアラート行と状態バッジ (Triggered / OK) の表示を待つ。
    await page.locator('text=Open orders backlog').waitFor({ timeout: 20_000 });
    await page.getByText('Triggered', { exact: true }).first().waitFor({ timeout: 20_000 });
    await page.getByText('OK', { exact: true }).first().waitFor({ timeout: 20_000 });
    // レールアイコンの hover ツールチップが写り込まないようマウスを退避させる。
    await page.mouse.move(900, 700);
    await page.waitForTimeout(600);

    console.log('› alerts-panel.png を撮影しています…');
    await page.screenshot({ path: resolve(outDir, 'alerts-panel.png') });

    console.log(`✓ スクリーンショットを ${outDir} に保存しました。`);
  } finally {
    if (browser) await browser.close();

    // 起動したプロセスをプロセスグループごと確実に停止する。
    console.log('› プロセスを停止しています…');
    killGroup(serverProc, 'SIGTERM');
    killGroup(webProc, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 1000));
    killGroup(serverProc, 'SIGKILL');
    killGroup(webProc, 'SIGKILL');
    console.log('› プロセスを停止しました。');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

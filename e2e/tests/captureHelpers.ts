import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { seedSavedQuery, TINY } from './helpers';

/** 撮影用ページのテーマとサイドバー状態を設定する。 */
export async function setCaptureTheme(page: Page, mode: 'light' | 'dark'): Promise<void> {
  const current = await page.locator('html').getAttribute('data-theme');
  if (current !== mode) await page.keyboard.press('Control+Alt+KeyT');
  await expect(page.locator('html')).toHaveAttribute('data-theme', mode);
  const editor = page.locator('.monaco-editor').first();
  await expect(editor).toBeVisible({ timeout: 20_000 });
  if (mode === 'dark') await expect(editor).toHaveClass(/vs-dark/, { timeout: 20_000 });
}

/** 撮影先を作成し、指定したファイル名でスクリーンショットを保存する。 */
export async function captureScreenshot(
  page: Page,
  outputDir: string,
  filename: string,
): Promise<void> {
  await mkdir(outputDir, { recursive: true });
  await page.screenshot({ path: join(outputDir, filename) });
}

/** ECharts の canvas に不透明な描画が現れるまで待つ。 */
export async function expectCanvasPainted(canvas: Locator): Promise<void> {
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(
      async () =>
        canvas.evaluate((element) => {
          const context = (element as HTMLCanvasElement).getContext('2d');
          if (!context) return false;
          const { data } = context.getImageData(
            0,
            0,
            (element as HTMLCanvasElement).width,
            (element as HTMLCanvasElement).height,
          );
          for (let index = 3; index < data.length; index += 4) {
            if (data[index] !== 0) return true;
          }
          return false;
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** API 応答を JSON として取得し、失敗を撮影テストのエラーにする。 */
export async function apiJson<T = unknown>(
  request: APIRequestContext,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await request.fetch(path, {
    method,
    headers: { 'Sec-Fetch-Site': 'same-origin' },
    ...(data === undefined ? {} : { data }),
  });
  expect(response.ok(), `${method} ${path}`).toBeTruthy();
  return response.json() as Promise<T>;
}

/** ワークフローの run が終端状態になるまで API の状態を待つ。 */
export async function waitWorkflowRun(request: APIRequestContext, runId: string): Promise<string> {
  await expect
    .poll(
      async () => {
        const run = await apiJson<{ status: string }>(
          request,
          'GET',
          `/api/workflow-runs/${runId}`,
        );
        return String(run.status);
      },
      { timeout: 60_000, intervals: [250, 500, 1000] },
    )
    .toBe('success');
  return 'success';
}

/** 撮影用のワークフローを API 経由で作成して実行する。 */
export async function seedWorkflow(request: APIRequestContext): Promise<void> {
  const existing = (await apiJson(request, 'GET', '/api/workflows')) as Array<{ id: string }>;
  for (const workflow of existing) {
    await apiJson(request, 'DELETE', `/api/workflows/${workflow.id}`);
  }
  const workflow = await apiJson<{ id: string }>(request, 'POST', '/api/workflows', {
    name: 'Daily sales report',
    description: 'Aggregate orders, then fan out to region/customer reports.',
    stages: [
      {
        steps: [
          {
            id: 'step-agg',
            name: 'Build daily aggregate',
            statement: 'SELECT count(*) AS orders FROM tpch.tiny.orders',
            catalog: 'tpch',
            schema: 'tiny',
            onFailure: 'stop',
          },
        ],
      },
      {
        steps: [
          {
            id: 'step-region',
            name: 'Sales by region',
            statement:
              'SELECT r.name, count(*) AS cnt\nFROM tpch.tiny.nation n\nJOIN tpch.tiny.region r ON n.regionkey = r.regionkey\nGROUP BY r.name',
            catalog: 'tpch',
            schema: 'tiny',
            onFailure: 'continue',
          },
          {
            id: 'step-customers',
            name: 'Top customers',
            statement: 'SELECT name FROM tpch.tiny.customer ORDER BY acctbal DESC LIMIT 10',
            catalog: 'tpch',
            schema: 'tiny',
            onFailure: 'continue',
          },
        ],
      },
      {
        steps: [
          {
            id: 'step-notify',
            name: 'Notify',
            statement: 'SELECT 1',
            catalog: 'tpch',
            schema: 'tiny',
            onFailure: 'continue',
          },
        ],
      },
    ],
    enabled: true,
  });
  const run = await apiJson<{ runId: string }>(
    request,
    'POST',
    `/api/workflows/${workflow.id}/run`,
  );
  const status = await waitWorkflowRun(request, String(run.runId));
  expect(status).toBe('success');
}

/** 名前が一致する保存済みクエリを再利用し、なければ作成する。 */
async function ensureSavedQuery(
  request: APIRequestContext,
  query: {
    name: string;
    description: string;
    statement: string;
    isFavorite?: boolean;
  },
): Promise<string> {
  const existing = (await apiJson(request, 'GET', '/api/saved-queries')) as Array<{
    id: string;
    name: string;
  }>;
  const found = existing.find((item) => item.name === query.name);
  if (found) return found.id;
  return seedSavedQuery(request, { ...query, ...TINY });
}

/** Dashboard と Alerts の撮影に必要なサンプルデータを作成する。 */
export async function seedDashboardAndAlerts(request: APIRequestContext): Promise<void> {
  const queries = [
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
      name: 'Dashboard top customers',
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
  const ids = new Map<string, string>();
  for (const query of queries) {
    ids.set(query.name, await ensureSavedQuery(request, query));
  }

  const alerts = (await apiJson(request, 'GET', '/api/alerts')) as Array<{
    id: string;
    name: string;
  }>;
  const ensureAlert = async (name: string, body: Record<string, unknown>): Promise<void> => {
    const found = alerts.find((alert) => alert.name === name);
    const alert = found
      ? found
      : await apiJson<{ id: string }>(request, 'POST', '/api/alerts', { name, ...body });
    await apiJson(request, 'POST', `/api/alerts/${alert.id}/eval`);
  };
  await ensureAlert('Open orders backlog', {
    savedQueryId: ids.get('Open orders'),
    columnName: 'open_orders',
    op: '>',
    value: '5000',
    selector: 'first',
    rearm: 0,
    cron: '*/30 * * * *',
  });
  await ensureAlert('Revenue floor', {
    savedQueryId: ids.get('Total revenue (M$)'),
    columnName: 'revenue_musd',
    op: '<',
    value: '100',
    selector: 'first',
    rearm: 0,
    cron: '0 * * * *',
  });
  if (!alerts.some((alert) => alert.name === 'Nightly freshness check')) {
    await apiJson(request, 'POST', '/api/alerts', {
      name: 'Nightly freshness check',
      savedQueryId: ids.get('Total orders'),
      columnName: 'orders',
      op: '==',
      value: '0',
      selector: 'first',
      rearm: 0,
      muted: true,
      cron: '0 6 * * *',
    });
  }

  const dashboards = (await apiJson(request, 'GET', '/api/dashboards')) as Array<{
    id: string;
    name: string;
  }>;
  if (dashboards.some((dashboard) => dashboard.name === 'Sales overview')) return;
  await apiJson(request, 'POST', '/api/dashboards', {
    name: 'Sales overview',
    description: 'Orders, revenue, and customer KPIs from tpch.tiny.',
    widgets: [
      {
        id: 'w-orders',
        kind: 'query',
        position: { col: 0, row: 0, sizeX: 2, sizeY: 2 },
        savedQueryId: ids.get('Total orders'),
        viz: 'counter',
        counter: { columnIndex: 0, label: 'Total orders' },
        title: 'Orders',
      },
      {
        id: 'w-revenue',
        kind: 'query',
        position: { col: 2, row: 0, sizeX: 2, sizeY: 2 },
        savedQueryId: ids.get('Total revenue (M$)'),
        viz: 'counter',
        counter: { columnIndex: 0, label: 'Revenue (M$)' },
        title: 'Revenue',
      },
      {
        id: 'w-customers',
        kind: 'query',
        position: { col: 4, row: 0, sizeX: 2, sizeY: 2 },
        savedQueryId: ids.get('Active customers'),
        viz: 'counter',
        counter: { columnIndex: 0, label: 'Customers' },
        title: 'Customers',
      },
      {
        id: 'w-priority',
        kind: 'query',
        position: { col: 0, row: 2, sizeX: 3, sizeY: 3 },
        savedQueryId: ids.get('Revenue by priority'),
        viz: 'chart',
        chart: { type: 'bars', xIndex: 0, yIndices: [2], sort: 'none', limit: 'all' },
        title: 'Revenue by priority (M$)',
      },
      {
        id: 'w-region',
        kind: 'query',
        position: { col: 3, row: 2, sizeX: 3, sizeY: 3 },
        savedQueryId: ids.get('Orders by region'),
        viz: 'chart',
        chart: { type: 'pie', xIndex: 0, yIndices: [1], sort: 'desc', limit: 'all' },
        title: 'Orders by region',
      },
      {
        id: 'w-top-customers',
        kind: 'query',
        position: { col: 0, row: 5, sizeX: 6, sizeY: 3 },
        savedQueryId: ids.get('Dashboard top customers'),
        viz: 'table',
        title: 'Top customers by balance',
      },
    ],
  });
}

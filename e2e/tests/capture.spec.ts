import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  apiJson,
  captureScreenshot,
  expectCanvasPainted,
  seedDashboardAndAlerts,
  seedWorkflow,
  setCaptureTheme,
} from './captureHelpers';
import {
  addCell,
  cell,
  getEditorValue,
  openResultTab,
  resetWorkspace,
  resultPane,
  runCellToGrid,
  runToHistory,
  seedSavedQuery,
  setCaret,
  setEditor,
  TINY,
  waitEditorReady,
} from './helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(
  process.env.CAPTURE_OUTPUT_DIR ?? resolve(__dirname, '../../docs/screenshots'),
);
const VIEWPORT = { width: 1440, height: 900 };
const SAMPLE_SQL = [
  '-- Trino SQL: live highlighting, completion and error markers',
  'SELECT',
  '  o.orderkey,',
  '  o.totalprice,',
  '  c.name AS customer',
  'FROM tpch.tiny.orders AS o',
  'JOIN tpch.tiny.customer AS c ON c.custkey = o.custkey',
  "WHERE o.orderstatus = 'O'",
  'ORDER BY o.totalprice DESC',
  'LIMIT 100',
].join('\n');

test.describe.configure({ mode: 'serial' });
test.use({ viewport: VIEWPORT, deviceScaleFactor: 2, colorScheme: 'light' });

test.beforeAll(async () => {
  await mkdir(OUTPUT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

/** 撮影用の Chart タブを開き、描画済み canvas を返す。 */
async function openChart(page: Parameters<typeof resetWorkspace>[0]) {
  await openResultTab(page, 'Chart');
  const pane = resultPane(page);
  const controls = pane.getByTestId('chart-controls');
  await expect(controls).toBeVisible({ timeout: 20_000 });
  const canvas = pane.getByTestId('chart-canvas').locator('canvas').first();
  await expectCanvasPainted(canvas);
  return { pane, controls, canvas };
}

/** 注文優先度別の結果を準備して Chart タブを開く。 */
async function openPriorityChart(page: Parameters<typeof resetWorkspace>[0]) {
  await setEditor(
    page,
    0,
    'SELECT orderpriority, count(*) c, sum(totalprice) s\nFROM tpch.sf1.orders\nGROUP BY orderpriority\nORDER BY orderpriority',
  );
  await runCellToGrid(page);
  return openChart(page);
}

test('capture p2b-light', async ({ page }) => {
  await captureScreenshot(page, OUTPUT_DIR, 'p2b-light.png');
});

test('capture p2b-dark', async ({ page }) => {
  await setCaptureTheme(page, 'dark');
  await captureScreenshot(page, OUTPUT_DIR, 'p2b-dark.png');
});

test('capture p2b-palette', async ({ page }) => {
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: 'Command palette' })).toBeVisible();
  await captureScreenshot(page, OUTPUT_DIR, 'p2b-palette.png');
  await page.keyboard.press('Escape');
});

test('capture p2b-history', async ({ page }) => {
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await captureScreenshot(page, OUTPUT_DIR, 'p2b-history.png');
});

test('capture p4b-history', async ({ page, request }) => {
  await runToHistory(request, 'SELECT count(*) FROM tpch.tiny.orders');
  await runToHistory(
    request,
    'SELECT orderstatus, count(*) FROM tpch.tiny.orders GROUP BY orderstatus',
  );
  await runToHistory(request, 'SELECT * FROM tpch.tiny.nation ORDER BY name LIMIT 25');
  await runToHistory(request, 'SELCT * FROM tpch.tiny.ordrs');
  await runToHistory(request, 'SELECT * FROM tpch.tiny.does_not_exist');
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText('FINISHED', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('FAILED', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'p4b-history.png');
});

test('capture final-light', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT n.name AS nation, r.name AS region, n.comment\nFROM tpch.tiny.nation n\nJOIN tpch.tiny.region r ON r.regionkey = n.regionkey\nORDER BY r.name, n.name',
  );
  await runCellToGrid(page);
  await captureScreenshot(page, OUTPUT_DIR, 'final-light.png');
});

test('capture final-dark', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT orderpriority, count(*) AS orders, sum(totalprice) AS revenue\nFROM tpch.tiny.orders\nGROUP BY orderpriority\nORDER BY orderpriority',
  );
  await runCellToGrid(page);
  await setCaptureTheme(page, 'dark');
  await captureScreenshot(page, OUTPUT_DIR, 'final-dark.png');
});

test('capture final-chart', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT orderpriority, count(*) AS orders, sum(totalprice) AS revenue\nFROM tpch.tiny.orders\nGROUP BY orderpriority\nORDER BY orderpriority',
  );
  await runCellToGrid(page);
  const { pane, controls, canvas } = await openChart(page);
  const yColumns = controls.getByRole('button', { name: 'Y axis columns' });
  await yColumns.click();
  await page.getByRole('option', { name: /revenue/ }).click();
  await yColumns.click();
  await expectCanvasPainted(canvas);
  await captureScreenshot(page, OUTPUT_DIR, 'final-chart.png');
  await expect(pane.getByTestId('chart-canvas')).toBeVisible();
});

test('capture final-variables', async ({ page }) => {
  await setEditor(
    page,
    0,
    "SELECT orderstatus, orderpriority, count(*) AS n, sum(totalprice) AS revenue\nFROM tpch.tiny.orders\nWHERE orderstatus = '${status=O,F,P}'\nGROUP BY orderstatus, orderpriority\nORDER BY orderpriority",
  );
  await expect(page.getByTestId('variable-panel')).toBeVisible({ timeout: 10_000 });
  await runCellToGrid(page);
  await captureScreenshot(page, OUTPUT_DIR, 'final-variables.png');
});

test('capture p3a-highlight', async ({ page }) => {
  await setEditor(page, 0, SAMPLE_SQL);
  await expect(page.locator('.monaco-editor').first()).toBeVisible();
  await captureScreenshot(page, OUTPUT_DIR, 'p3a-highlight.png');
});

test('capture p3a-completion', async ({ page }) => {
  await setEditor(page, 0, 'SELECT * FROM ');
  await page.keyboard.press('Control+Space');
  await page.locator('.suggest-widget').waitFor({ timeout: 20_000 });
  await page.keyboard.press('Escape');
  await page.locator('[data-testid="sql-editor"]').first().click();
  await page.keyboard.press('Control+Space');
  await expect(page.locator('.suggest-widget').last()).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'p3a-completion.png');
  await page.keyboard.press('Escape');
});

test('capture p3a-error', async ({ page }) => {
  await setEditor(page, 0, 'SELECT FROM tpch.tiny.orders');
  const marker = cell(page).locator('.squiggly-error, .cdr.squiggly-error').first();
  await expect(marker).toBeVisible({ timeout: 20_000 });
  const markerBox = await marker.boundingBox();
  expect(markerBox).not.toBeNull();
  if (!markerBox) {
    throw new Error('エラーマーカーの位置を取得できませんでした');
  }
  await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
  await expect(page.locator('.monaco-hover').first()).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'p3a-error.png');
});

test('capture p3a-dark', async ({ page }) => {
  await setEditor(page, 0, SAMPLE_SQL);
  await setCaptureTheme(page, 'dark');
  await captureScreenshot(page, OUTPUT_DIR, 'p3a-dark.png');
});

test('capture p3b-running', async ({ page }) => {
  await setEditor(page, 0, 'SELECT * FROM tpch.sf1000.lineitem CROSS JOIN tpch.tiny.nation');
  await cell(page).getByRole('switch', { name: 'Toggle auto LIMIT' }).click();
  await cell(page).getByRole('button', { name: 'Run cell', exact: true }).click();
  const state = cell(page).getByText('RUNNING', { exact: true }).first();
  await expect(state).toBeVisible({ timeout: 15_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'p3b-running.png');
  const stop = cell(page).getByRole('button', { name: 'Stop' });
  await stop.click({ timeout: 3_000 }).catch(() => undefined);
  await expect(
    cell(page)
      .getByText(/^(CANCELED|FINISHED|FAILED)$/, { exact: true })
      .first(),
  ).toBeVisible({ timeout: 20_000 });
});

test('capture p3b-grid', async ({ page }) => {
  await setEditor(page, 0, 'SELECT * FROM tpch.sf1.orders');
  await runCellToGrid(page);
  await captureScreenshot(page, OUTPUT_DIR, 'p3b-grid.png');
});

test('capture p3b-agg', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT count(*) AS orders, orderstatus\nFROM tpch.sf1.orders\nGROUP BY orderstatus',
  );
  await runCellToGrid(page);
  await captureScreenshot(page, OUTPUT_DIR, 'p3b-agg.png');
});

test('capture p3b-error', async ({ page }) => {
  await setEditor(page, 0, 'SELECT * FROM tpch.sf1.no_such_table');
  await cell(page).getByRole('button', { name: 'Run cell', exact: true }).click();
  await expect(cell(page).getByTestId('error-panel')).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'p3b-error.png');
});

test('capture p3b-explain', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT orderstatus, count(*) FROM tpch.sf1.orders GROUP BY orderstatus',
  );
  await runCellToGrid(page);
  await openResultTab(page, 'Explain');
  await expect(resultPane(page).locator('pre')).toBeVisible({ timeout: 30_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'p3b-explain.png');
});

test('capture p4a-variables', async ({ page }) => {
  await setEditor(
    page,
    0,
    "SELECT orderkey, orderstatus, totalprice\nFROM tpch.tiny.orders\nWHERE orderstatus = '${status=O,F,P}'\nLIMIT ${n=10}",
  );
  const variables = page.getByTestId('variable-panel');
  await expect(variables).toBeVisible({ timeout: 10_000 });
  await variables.locator('#var-status').selectOption('F');
  await variables.locator('#var-n').fill('8');
  await runCellToGrid(page);
  await captureScreenshot(page, OUTPUT_DIR, 'p4a-variables.png');
});

test('capture p4a-markdown', async ({ page }) => {
  await addCell(page, 'markdown');
  const markdown = page.getByTestId('notebook-cell').nth(1);
  await markdown.getByRole('button', { name: 'Edit markdown' }).click();
  const source = markdown.getByRole('textbox', { name: 'Markdown source' });
  await expect(source).toBeVisible();
  await source.fill(
    '## Order status review\n\nThis notebook filters **tpch.tiny.orders** by a `${status}` variable.\n\n- `O` is open\n- `F` is fulfilled\n- `P` is in process\n\n| status | meaning |\n| --- | --- |\n| O | open |\n| F | fulfilled |\n\n```sql\nSELECT * FROM tpch.tiny.orders\n```',
  );
  await expect(source).toHaveValue(/Order status review/);
  await captureScreenshot(page, OUTPUT_DIR, 'p4a-markdown.png');
});

test('capture p4a-reorder', async ({ page }) => {
  // ユーザー指摘3: 上下移動ボタンは撤去し、並べ替えはグリップハンドルのみで行う。
  await addCell(page, 'sql');
  const firstCell = cell(page, 0);
  await expect(firstCell.getByRole('button', { name: 'Drag to reorder' })).toBeVisible();
  await firstCell.getByRole('button', { name: 'Drag to reorder' }).hover();
  await captureScreenshot(page, OUTPUT_DIR, 'p4a-reorder.png');
});

test('capture p4a-save', async ({ page }) => {
  await page.keyboard.press('Control+s');
  const dialog = page.getByRole('dialog', { name: 'Save notebook' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Notebook name' }).fill('Order status review');
  await captureScreenshot(page, OUTPUT_DIR, 'p4a-save.png');
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/notebooks') &&
      response.request().method() === 'POST' &&
      response.ok(),
  );
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await saved;
});

test('capture p4a-tabs', async ({ page }) => {
  await page.keyboard.press('Control+s');
  const dialog = page.getByRole('dialog', { name: 'Save notebook' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Notebook name' }).fill('Order status review');
  const saved = page.waitForResponse(
    (response) =>
      response.url().endsWith('/api/notebooks') &&
      response.request().method() === 'POST' &&
      response.ok(),
  );
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await saved;
  await page.getByRole('button', { name: 'New notebook' }).click();
  await waitEditorReady(page);
  await setEditor(page, 0, 'SELECT count(*) FROM tpch.tiny.nation');
  await expect(page.getByLabel('Unsaved changes')).toBeVisible();
  await captureScreenshot(page, OUTPUT_DIR, 'p4a-tabs.png');
});

test('capture p4b-tree', async ({ page }) => {
  await page.getByRole('button', { name: /^tpch/ }).first().click();
  await page.getByRole('button', { name: /^tiny/ }).first().click();
  await page
    .getByRole('button', { name: /^orders/ })
    .first()
    .click();
  const totalprice = page.getByRole('button', { name: /^totalprice/ }).first();
  await expect(totalprice).toBeVisible({ timeout: 20_000 });
  await setEditor(page, 0, 'SELECT \nFROM tpch.tiny.orders');
  await setCaret(page, 0, { lineNumber: 1, column: 8 });
  await totalprice.click();
  await expect.poll(async () => getEditorValue(page, 0)).toContain('totalprice');
  await captureScreenshot(page, OUTPUT_DIR, 'p4b-tree.png');
});

test('capture p4b-detail', async ({ page }) => {
  await page.getByRole('button', { name: /^tpch/ }).first().click();
  await page.getByRole('button', { name: /^tiny/ }).first().click();
  await page.getByRole('button', { name: 'Details for orders' }).first().click();
  const dialog = page.getByRole('dialog', { name: /orders details/ });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByText('Sample · 10 rows')).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'p4b-detail.png');
});

test('capture p4b-context', async ({ page }) => {
  await page.getByRole('button', { name: 'catalog.schema context' }).click();
  const dialog = page.getByRole('dialog', { name: 'Select context' });
  await expect(dialog).toBeVisible();
  await dialog.getByText('tpch', { exact: true }).first().hover();
  await expect(dialog.getByRole('button', { name: 'sf1', exact: true })).toBeVisible();
  await captureScreenshot(page, OUTPUT_DIR, 'p4b-context.png');
});

test('capture p4b-saved', async ({ page, request }) => {
  const definitions = [
    {
      name: 'Revenue by segment',
      description: 'Gross revenue grouped by market segment.',
      statement:
        'SELECT c.mktsegment, sum(o.totalprice) AS revenue\nFROM tpch.tiny.orders o\nJOIN tpch.tiny.customer c ON c.custkey = o.custkey\nGROUP BY 1\nORDER BY revenue DESC',
      ...TINY,
      isFavorite: true,
    },
    {
      name: 'Late shipments by mode',
      description: 'Line items where receipt slipped past commit date.',
      statement:
        'SELECT shipmode, count(*) AS late\nFROM tpch.tiny.lineitem\nWHERE receiptdate > commitdate\nGROUP BY shipmode\nORDER BY late DESC',
      ...TINY,
    },
    {
      name: 'Top customers',
      description: 'Customers ranked by total order value.',
      statement:
        'SELECT c.name, sum(o.totalprice) AS spend\nFROM tpch.tiny.orders o\nJOIN tpch.tiny.customer c ON c.custkey = o.custkey\nGROUP BY 1\nORDER BY spend DESC\nLIMIT 50',
      ...TINY,
    },
  ];
  const existing = (await apiJson(request, 'GET', '/api/saved-queries')) as Array<{ name: string }>;
  for (const definition of definitions) {
    if (!existing.some((item) => item.name === definition.name)) {
      await seedSavedQuery(request, definition);
    }
  }
  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  const row = page.getByText('Revenue by segment').first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
  await expect(page.getByRole('button', { name: 'Insert' })).toBeVisible();
  await captureScreenshot(page, OUTPUT_DIR, 'p4b-saved.png');
});

test('capture p5-bar', async ({ page }) => {
  const { controls, canvas } = await openPriorityChart(page);
  const yColumns = controls.getByRole('button', { name: 'Y axis columns' });
  await yColumns.click();
  await page.getByRole('option', { name: /^s/ }).click();
  await yColumns.click();
  await expectCanvasPainted(canvas);
  await captureScreenshot(page, OUTPUT_DIR, 'p5-bar.png');
});

test('capture p5-pie', async ({ page }) => {
  const { controls, canvas } = await openPriorityChart(page);
  await controls.getByRole('button', { name: 'Pie' }).click();
  await expect(controls.getByRole('button', { name: 'Pie' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expectCanvasPainted(canvas);
  await captureScreenshot(page, OUTPUT_DIR, 'p5-pie.png');
});

test('capture p5-timeline', async ({ page }) => {
  await setEditor(
    page,
    0,
    "SELECT orderdate, sum(totalprice) revenue\nFROM tpch.sf1.orders\nWHERE orderdate >= DATE '1995-01-01' AND orderdate < DATE '1995-04-01'\nGROUP BY orderdate\nORDER BY orderdate",
  );
  await runCellToGrid(page);
  const { controls, canvas } = await openChart(page);
  await controls.getByRole('button', { name: 'Timeline' }).click();
  await expectCanvasPainted(canvas);
  await captureScreenshot(page, OUTPUT_DIR, 'p5-timeline.png');
});

test('capture p5-scatter', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT quantity, extendedprice, discount\nFROM tpch.sf1.lineitem\nLIMIT 2000',
  );
  await runCellToGrid(page);
  const { controls, canvas } = await openChart(page);
  await controls.getByRole('button', { name: 'Scatter' }).click();
  await expectCanvasPainted(canvas);
  await controls.getByRole('combobox', { name: 'Scatter point-size column' }).click();
  await page.getByRole('option', { name: /discount/ }).click();
  await expectCanvasPainted(canvas);
  await captureScreenshot(page, OUTPUT_DIR, 'p5-scatter.png');
});

test('capture p5-dark', async ({ page }) => {
  const { canvas } = await openPriorityChart(page);
  await setCaptureTheme(page, 'dark');
  await expectCanvasPainted(canvas);
  await captureScreenshot(page, OUTPUT_DIR, 'p5-dark.png');
});

test('capture p5-shortcuts', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Command palette' });
  await expect(palette).toBeVisible();
  await palette.locator('input[placeholder="Type a command…"]').fill('keyboard');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await captureScreenshot(page, OUTPUT_DIR, 'p5-shortcuts.png');
});

test('capture workflow-canvas', async ({ page, request }) => {
  await seedWorkflow(request);
  await resetWorkspace(page);
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  const row = page.locator('button', { hasText: 'Daily sales report' }).first();
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByText('Stage 1').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('success').first()).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'workflow-canvas.png');
});

test('capture dashboard-grid', async ({ page, request }) => {
  await seedDashboardAndAlerts(request);
  await resetWorkspace(page);
  await page.getByRole('button', { name: 'Dashboards', exact: true }).click();
  const dashboard = page.locator('button', { hasText: 'Sales overview' }).first();
  await expect(dashboard).toBeVisible({ timeout: 20_000 });
  await dashboard.click();
  await expect(page.getByText('15,000').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('canvas').nth(1)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Customer#').first()).toBeVisible({ timeout: 60_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'dashboard-grid.png');
});

test('capture alerts-panel', async ({ page, request }) => {
  await seedDashboardAndAlerts(request);
  await resetWorkspace(page);
  await page.getByRole('button', { name: 'Alerts', exact: true }).click();
  await expect(page.getByText('Open orders backlog')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Triggered', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByText('OK', { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await captureScreenshot(page, OUTPUT_DIR, 'alerts-panel.png');
});

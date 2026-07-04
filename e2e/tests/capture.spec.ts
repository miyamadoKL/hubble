import { test } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resetWorkspace, setEditor, runCellToGrid, resultPane, openResultTab } from './helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * README hero-shot capture. Not an assertion suite — it drives the
 * proven E2E helpers to render four representative views and writes them under
 * docs/screenshots. Run explicitly:
 *
 *   npx playwright test capture.spec.ts
 *
 * (It is excluded from the default suite via the file name filter in CI; locally
 * it runs harmlessly and just re-emits the PNGs.)
 */

const OUT = resolve(__dirname, '../../docs/screenshots');

test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

test('capture final-light', async ({ page }) => {
  await resetWorkspace(page, { theme: 'light' });
  await setEditor(
    page,
    0,
    'SELECT n.name AS nation, r.name AS region, n.comment\nFROM tpch.tiny.nation n\nJOIN tpch.tiny.region r ON r.regionkey = n.regionkey\nORDER BY r.name, n.name',
  );
  await runCellToGrid(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(OUT, 'final-light.png') });
});

test('capture final-dark', async ({ page }) => {
  await resetWorkspace(page, { theme: 'dark' });
  await setEditor(
    page,
    0,
    'SELECT orderpriority, count(*) AS orders, sum(totalprice) AS revenue\nFROM tpch.tiny.orders\nGROUP BY orderpriority\nORDER BY orderpriority',
  );
  await runCellToGrid(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(OUT, 'final-dark.png') });
});

test('capture final-chart', async ({ page }) => {
  await resetWorkspace(page, { theme: 'light' });
  await setEditor(
    page,
    0,
    'SELECT orderpriority, count(*) AS orders, sum(totalprice) AS revenue\nFROM tpch.tiny.orders\nGROUP BY orderpriority\nORDER BY orderpriority',
  );
  await runCellToGrid(page);
  await openResultTab(page, 'Chart');
  const pane = resultPane(page);
  await pane.getByTestId('chart-controls').waitFor({ timeout: 20_000 });
  await pane.getByTestId('chart-canvas').locator('canvas').first().waitFor({ timeout: 20_000 });
  // Add the second numeric measure so both series plot.
  await pane.getByTestId('chart-controls').getByRole('button', { name: 'Y axis columns' }).click();
  await page.getByRole('option', { name: /revenue/ }).click();
  await pane.getByTestId('chart-controls').getByRole('button', { name: 'Y axis columns' }).click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: resolve(OUT, 'final-chart.png') });
});

test('capture final-variables', async ({ page }) => {
  await resetWorkspace(page, { theme: 'light' });
  await setEditor(
    page,
    0,
    "SELECT orderstatus, orderpriority, count(*) AS n, sum(totalprice) AS revenue\nFROM tpch.tiny.orders\nWHERE orderstatus = '${status=O,F,P}'\nGROUP BY orderstatus, orderpriority\nORDER BY orderpriority",
  );
  await page.getByTestId('variable-panel').waitFor({ timeout: 10_000 });
  await runCellToGrid(page);
  await page.waitForTimeout(400);
  await page.screenshot({ path: resolve(OUT, 'final-variables.png') });
});

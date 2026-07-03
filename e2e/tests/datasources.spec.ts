/**
 * マルチデータソース UI / 実行の E2E (MULTI_DS_E2E=1 時のみ)。
 *
 * 既定の `pnpm --filter @hubble/e2e test` ではスキップされ、既存 Trino 単体 E2E に影響しない。
 * 実行例:
 *   MULTI_DS_E2E=1 pnpm --filter @hubble/e2e test tests/datasources.spec.ts
 */
import { test, expect } from '@playwright/test';
import {
  resetWorkspace,
  setEditor,
  selectDatasource,
  runCellToGrid,
  isPostgresDemoReachable,
} from './helpers';

const multiDs = process.env.MULTI_DS_E2E === '1';

test.describe('multi-datasource', () => {
  test.skip(!multiDs, 'Set MULTI_DS_E2E=1 to run multi-datasource E2E');

  let postgresReachable = false;

  test.beforeAll(async ({ request }) => {
    postgresReachable = await isPostgresDemoReachable(request);
  });

  test.beforeEach(async ({ page }) => {
    await resetWorkspace(page, { sidebarTab: 'data' });
  });

  test('lists configured datasources in the selector', async ({ page }) => {
    await page.getByRole('button', { name: 'Data source' }).click();
    await expect(page.getByRole('option').filter({ hasText: 'Demo Trino' })).toBeVisible();
    await expect(page.getByRole('option').filter({ hasText: 'Demo MySQL' })).toBeVisible();
    await expect(page.getByRole('option').filter({ hasText: 'Demo PostgreSQL' })).toBeVisible();
  });

  test('disables Query Guard estimate UI for mysql and postgresql', async ({ page }) => {
    await selectDatasource(page, 'Demo MySQL');
    await setEditor(page, 0, 'SELECT 1');
    await expect(page.getByText('Estimate unavailable for this data source')).toBeVisible();

    await selectDatasource(page, 'Demo PostgreSQL');
    await expect(page.getByText('Estimate unavailable for this data source')).toBeVisible();

    await selectDatasource(page, 'Demo Trino');
    await expect(page.getByText('Estimate unavailable for this data source')).toHaveCount(0);
  });

  test('refetches metadata when switching datasources', async ({ page }) => {
    await expect(page.getByText('tpch', { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    const pgCatalogs = page.waitForResponse(
      (r) =>
        r.url().includes('/api/datasources/postgres-demo/catalogs') &&
        r.request().method() === 'GET' &&
        r.status() === 200,
    );
    await selectDatasource(page, 'Demo PostgreSQL');
    const resp = await pgCatalogs;
    const body = (await resp.json()) as { items?: { name: string }[] };
    expect(body.items?.some((c) => c.name === 'demo')).toBe(true);
  });

  test('runs a SELECT against demo PostgreSQL when reachable', async ({ page }) => {
    test.skip(!postgresReachable, 'demo-postgres is not reachable on 127.0.0.1:5434');

    await selectDatasource(page, 'Demo PostgreSQL');
    await setEditor(page, 0, 'SELECT count(*) AS n FROM demo_items');
    await runCellToGrid(page);
    await expect(page.getByTestId('result-grid').getByText('3').first()).toBeVisible();
  });
});

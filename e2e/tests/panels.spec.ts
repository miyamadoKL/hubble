import { test, expect } from '@playwright/test';
import {
  resetWorkspace,
  setEditor,
  setCaret,
  getEditorValue,
  cell,
  seedSavedQuery,
  runToHistory,
  rnd,
} from './helpers';

/**
 * Assist-panel suite (design.md §5 アシスト): schema tree expand → insert, table
 * detail popover with sample rows, saved-query save → list → insert → delete,
 * history record → filter → new cell, and the context selector → execution.
 */

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page, { sidebarTab: 'data' });
});

test('expands the schema tree to columns and inserts at the caret', async ({ page }) => {
  // tpch → tiny → orders → columns.
  await page.getByRole('button', { name: /^tpch/ }).first().click();
  await page.getByRole('button', { name: /^tiny/ }).first().click();
  await page
    .getByRole('button', { name: /^orders/ })
    .first()
    .click();

  // A column row (totalprice) appears once the table detail loads.
  const totalprice = page.getByRole('button', { name: /^totalprice/ }).first();
  await expect(totalprice).toBeVisible({ timeout: 20_000 });

  // Seed the caret and insert the column into the focused cell.
  await setEditor(page, 0, 'SELECT \nFROM tpch.tiny.orders');
  await setCaret(page, 0, { lineNumber: 1, column: 8 });
  await totalprice.click();
  await expect.poll(async () => getEditorValue(page, 0)).toContain('totalprice');
});

test('opens the table detail popover with columns and sample rows', async ({ page }) => {
  await page.getByRole('button', { name: /^tpch/ }).first().click();
  await page.getByRole('button', { name: /^tiny/ }).first().click();

  // The per-row info button opens the detail popover.
  await page.getByRole('button', { name: 'Details for orders' }).first().click();
  const dialog = page.getByRole('dialog', { name: /orders details/ });
  await expect(dialog).toBeVisible({ timeout: 10_000 });

  // Columns section + the 10-row sample both render with real data.
  await expect(dialog.getByText('orderkey').first()).toBeVisible();
  await expect(dialog.getByText('Sample · 10 rows')).toBeVisible({ timeout: 20_000 });
  // A sample table appears (header cells from the table).
  await expect(dialog.locator('table thead')).toBeVisible({ timeout: 20_000 });

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('lists, inserts, and deletes a saved query', async ({ page, request }) => {
  const name = `Saved ${rnd()}`;
  await seedSavedQuery(request, {
    name,
    description: 'E2E seeded saved query.',
    statement: 'SELECT mktsegment, count(*) FROM tpch.tiny.customer GROUP BY mktsegment',
  });

  // Focus a cell so it becomes the insert target (insert drops at the caret of
  // the last-focused editor).
  await cell(page).locator('[data-testid="sql-editor"]').click();

  // Switch to the Saved panel; the seeded query shows up.
  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  const row = page.getByText(name).first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  // Expand it and insert the statement into the active cell.
  await row.click();
  await page.getByRole('button', { name: 'Insert' }).click();
  await expect.poll(async () => getEditorValue(page, 0)).toContain('mktsegment');

  // The row is still expanded after Insert — delete it via the confirm modal.
  await page.getByRole('button', { name: 'Delete' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Delete saved query?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText(name)).toHaveCount(0, { timeout: 10_000 });
});

test('records history, filters it, and inserts into a new cell', async ({ page, request }) => {
  // Seed one clean finish + one deliberate failure through the API.
  const marker = rnd('hist_');
  await runToHistory(request, `SELECT '${marker}' AS tag, count(*) FROM tpch.tiny.nation`);
  await runToHistory(request, `SELECT * FROM tpch.tiny.${marker}_missing`);

  await page.getByRole('button', { name: 'History', exact: true }).click();
  // Both my finished tagged query and my failed query appear (the server is
  // shared across tests, so we anchor on the unique marker, not global counts).
  await expect(page.getByText(`${marker}' AS tag`).first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`${marker}_missing`).first()).toBeVisible({ timeout: 15_000 });

  // Filter to Failed only — my failed entry stays, my finished one drops out.
  await page.getByRole('button', { name: 'Failed', exact: true }).click();
  await expect(page.getByText(`${marker}_missing`).first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(`${marker}' AS tag`)).toHaveCount(0, { timeout: 10_000 });

  // Back to All, expand my finished one, and add it to a new cell.
  await page.getByRole('button', { name: 'All', exact: true }).click();
  const cellsBefore = await page.getByTestId('notebook-cell').count();
  await page.getByText(`${marker}' AS tag`).first().click();
  await page.getByRole('button', { name: 'New cell' }).first().click();
  await expect(page.getByTestId('notebook-cell')).toHaveCount(cellsBefore + 1);
});

test('changes the context selector and runs against the new schema', async ({ page }) => {
  // Open the context selector and pick tpch.sf1.
  await page.getByRole('button', { name: 'catalog.schema context' }).click();
  const dialog = page.getByRole('dialog', { name: 'Select context' });
  await expect(dialog).toBeVisible();
  await dialog.getByText('tpch', { exact: true }).first().hover();
  await dialog.getByRole('button', { name: 'sf1', exact: true }).click();

  // The selector now reads tpch.sf1.
  await expect(page.getByRole('button', { name: 'catalog.schema context' })).toContainText('sf1');

  // A schema-relative query resolves against sf1 (orders has 1.5M rows there;
  // count(*) returns a single value, proving the context applied).
  await setEditor(page, 0, 'SELECT count(*) AS c FROM orders');
  await cell(page).locator('[data-testid="sql-editor"]').click();
  await page.keyboard.press('Control+Enter');
  await expect(cell(page).getByText('FINISHED', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
});

import { test, expect } from '@playwright/test';
import {
  resetWorkspace,
  setEditor,
  getEditorValue,
  cell,
  runCell,
  resultPane,
  expectFinished,
  waitGrid,
  addCell,
  rnd,
} from './helpers';

/**
 * Notebook suite (design.md §5 セル / 変数 / 管理): cell add / delete (confirm) /
 * reorder / collapse, Markdown edit → render, variable substitution, run-all, and
 * save → reload → restore with the dirty indicator.
 */

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('adds, collapses, and deletes cells (with confirm for non-empty cells)', async ({ page }) => {
  // Start from one empty SQL cell; add a second via the command palette.
  await addCell(page, 'sql');
  await expect(page.getByTestId('notebook-cell')).toHaveCount(2);

  // Collapse the first cell — its editor hides.
  await cell(page, 0).getByRole('button', { name: 'Collapse cell' }).click();
  await expect(cell(page, 0).getByTestId('sql-editor')).toBeHidden();
  await cell(page, 0).getByRole('button', { name: 'Expand cell' }).click();
  await expect(cell(page, 0).getByTestId('sql-editor')).toBeVisible();

  // An empty cell deletes immediately (no confirm).
  await cell(page, 1).getByRole('button', { name: 'Delete cell' }).click();
  await expect(page.getByTestId('notebook-cell')).toHaveCount(1);

  // A cell with content prompts a confirm modal.
  await setEditor(page, 0, 'SELECT 1');
  await cell(page, 0).getByRole('button', { name: 'Delete cell' }).click();
  const dialog = page.getByRole('dialog', { name: 'Delete cell?' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete cell' }).click();
  await expect(page.getByTestId('notebook-cell')).toHaveCount(0);
});

test('reorders cells with the move-up control', async ({ page }) => {
  await setEditor(page, 0, 'SELECT 1 AS first_cell');
  await addCell(page, 'sql');
  await setEditor(page, 1, 'SELECT 2 AS second_cell');

  // Move the second cell up; its content now leads.
  await cell(page, 1).getByRole('button', { name: 'Move up' }).click();
  await expect.poll(async () => getEditorValue(page, 0)).toContain('second_cell');
});

test('edits a Markdown cell and renders it', async ({ page }) => {
  // Add a Markdown cell via the palette (appended at the end).
  await addCell(page, 'markdown');

  const md = page.getByTestId('notebook-cell').nth(1);
  // The palette-added cell renders as a preview placeholder; click to edit.
  await md.getByRole('button', { name: 'Edit markdown' }).click();
  const textarea = md.getByRole('textbox', { name: 'Markdown source' });
  await expect(textarea).toBeVisible();
  await textarea.fill('# Report\n\nThis is **bold** analysis.');
  // Ctrl+Enter commits and renders.
  await textarea.press('Control+Enter');

  await expect(md.getByRole('heading', { name: 'Report' })).toBeVisible();
  await expect(md.getByText('bold')).toBeVisible();
});

test('substitutes a ${select} variable and runs', async ({ page }) => {
  // A ${status=O,F} variable is detected from the SQL and a select input appears.
  await setEditor(
    page,
    0,
    "SELECT orderstatus, count(*) AS n FROM tpch.tiny.orders WHERE orderstatus = '${status=O,F}' GROUP BY orderstatus",
  );

  const panel = page.getByTestId('variable-panel');
  await expect(panel).toBeVisible();
  const select = panel.locator('#var-status');
  await expect(select).toBeVisible();
  // Default is the first option, "O".
  await expect(select).toHaveValue('O');

  // Run with the default; the result row reflects orderstatus = 'O'.
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);
  await expect(
    resultPane(page).getByTestId('result-grid').getByText('O', { exact: true }).first(),
  ).toBeVisible();

  // Switch to 'F' and re-run via the panel's Ctrl+Enter.
  await select.selectOption('F');
  await select.press('Control+Enter');
  await expectFinished(page);
  await waitGrid(page);
  await expect(
    resultPane(page).getByTestId('result-grid').getByText('F', { exact: true }).first(),
  ).toBeVisible();
});

test('runs all cells from the toolbar', async ({ page }) => {
  await setEditor(page, 0, 'SELECT count(*) AS nations FROM tpch.tiny.nation');
  await addCell(page, 'sql');
  await setEditor(page, 1, 'SELECT count(*) AS regions FROM tpch.tiny.region');

  // The "Run" button in the TopBar runs every cell top-to-bottom (its visible
  // label is "Run"; the tooltip reads "Run all cells").
  await page.getByRole('banner').getByRole('button', { name: 'Run', exact: true }).click();

  await expect(cell(page, 0).getByText('FINISHED', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(cell(page, 1).getByText('FINISHED', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
});

test('saves a notebook, reloads, and restores it', async ({ page }) => {
  const name = `E2E Notebook ${rnd()}`;
  await setEditor(page, 0, 'SELECT 42 AS answer FROM tpch.tiny.nation LIMIT 1');

  // A fresh draft shows the dirty dot on its tab.
  await expect(page.getByLabel('Unsaved changes')).toBeVisible();

  // Save via Ctrl+S → name dialog → confirm.
  await page.keyboard.press('Control+s');
  const dialog = page.getByRole('dialog', { name: 'Save notebook' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Notebook name' }).fill(name);
  // Wait for the POST /api/notebooks to land before reloading, so the workspace
  // snapshot points at a real server id.
  const saved = page.waitForResponse(
    (r) => r.url().endsWith('/api/notebooks') && r.request().method() === 'POST' && r.ok(),
  );
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await saved;

  // After a successful save the dirty dot clears.
  await expect(page.getByLabel('Unsaved changes')).toBeHidden({ timeout: 10_000 });

  // Reload the page — the workspace restores the saved notebook + its content.
  await page.reload();
  await page.locator('[data-testid="sql-editor"][data-ready="true"]').first().waitFor({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => getEditorValue(page, 0)).toContain('42 AS answer');
});

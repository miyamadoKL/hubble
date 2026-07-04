import { test, expect } from '@playwright/test';
import {
  resetWorkspace,
  setEditor,
  cell,
  runCell,
  runCellToGrid,
  resultPane,
  expectFinished,
} from './helpers';

/**
 * Editor suite. Drives the Monaco SQL cell
 * against a real Trino: run → grid, syntax-error marker + line:col, format, and
 * the auto-LIMIT control state.
 */

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('runs SQL with Ctrl+Enter and shows real tpch.tiny.nation rows', async ({ page }) => {
  await setEditor(page, 0, 'SELECT * FROM tpch.tiny.nation ORDER BY nationkey');
  await runCellToGrid(page);

  const pane = resultPane(page);
  // 25 nations, 4 columns (nationkey, name, regionkey, comment).
  await expect(pane.getByText(/25 rows · 4 columns/)).toBeVisible();
  // Concrete data — ALGERIA is nationkey 0 in tpch.
  await expect(pane.getByTestId('result-grid').getByText('ALGERIA').first()).toBeVisible();
  await expect(pane.getByTestId('result-grid').getByText('VIETNAM').first()).toBeVisible();
});

test('surfaces a syntax error with message and line:column', async ({ page }) => {
  await setEditor(page, 0, 'SELECT FROM tpch.tiny.nation');
  await runCell(page);

  // Cell badge goes FAILED; the error panel shows the Trino error + position.
  await expect(cell(page).getByText('FAILED', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  const errorPanel = cell(page).getByTestId('error-panel');
  await expect(errorPanel).toBeVisible();
  await expect(errorPanel).toContainText('SYNTAX_ERROR');
  await expect(errorPanel).toContainText(/line 1:8/);
  await expect(errorPanel).toContainText(/mismatched input 'FROM'/);
});

test('error position is reflected as a Monaco marker in the gutter', async ({ page }) => {
  await setEditor(page, 0, 'SELECT FROM tpch.tiny.nation');
  await runCell(page);
  await expect(cell(page).getByText('FAILED', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  // Monaco renders error squiggles + a marker; assert a marker decoration exists
  // on the editor (its presence proves the error was pushed as a model marker).
  const markers = cell(page).locator('.squiggly-error, .cdr.squiggly-error');
  await expect(markers.first()).toBeVisible({ timeout: 10_000 });
});

test('formats SQL via Ctrl+Shift+F (sql-formatter, no server round-trip)', async ({ page }) => {
  await setEditor(page, 0, 'select nationkey,name from tpch.tiny.nation where regionkey=1');
  // Focus the editor and invoke the Trino format command
  // (Ctrl/Cmd+I or Ctrl+Shift+F).
  await cell(page).locator('[data-testid="sql-editor"]').click();
  await page.keyboard.press('Control+Shift+KeyF');

  // The formatter upper-cases keywords and breaks clauses onto their own lines.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const ed = (window as unknown as { __fableEditors?: { getValue: () => string }[] })
          .__fableEditors?.[0];
        return ed?.getValue() ?? '';
      }),
    )
    .toMatch(/SELECT[\s\S]*FROM[\s\S]*WHERE/);
  const formatted = await page.evaluate(() => {
    const ed = (window as unknown as { __fableEditors?: { getValue: () => string }[] })
      .__fableEditors?.[0];
    return ed?.getValue() ?? '';
  });
  // Clauses on separate lines (multi-line output).
  expect(formatted.split('\n').length).toBeGreaterThan(1);
});

test('auto-LIMIT control shows the default and toggles off', async ({ page }) => {
  // The LIMIT control is part of the SQL cell toolbar.
  const toggle = cell(page).getByRole('switch', { name: 'Toggle auto LIMIT' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // The value defaults to 5,000 (from /api/config).
  await expect(cell(page).getByRole('button', { name: 'Edit LIMIT value' })).toHaveText('5,000');

  // Toggling it off flips the switch (so SELECTs run without an appended LIMIT).
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
});

test('auto-LIMIT caps a LIMIT-less SELECT at the configured value', async ({ page }) => {
  // lineitem has ~60k rows; with auto-LIMIT (5000) the grid loads exactly 5000.
  await setEditor(page, 0, 'SELECT orderkey, partkey, quantity FROM tpch.tiny.lineitem');
  await runCell(page);
  await expectFinished(page);
  const pane = resultPane(page);
  await pane.getByRole('tab', { name: 'Grid' }).click();
  await pane.getByTestId('result-grid').waitFor({ timeout: 30_000 });
  await expect(pane.getByText(/5,000 rows · 3 columns/)).toBeVisible({ timeout: 30_000 });
});

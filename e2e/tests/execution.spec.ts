import { test, expect } from '@playwright/test';
import {
  resetWorkspace,
  setEditor,
  cell,
  runCell,
  resultPane,
  expectFinished,
  openResultTab,
} from './helpers';

/**
 * Execution suite (design.md §5 セルと実行): sequential multi-statement runs that
 * stop on the first error, cancel of a heavy query, the EXPLAIN tab, and the
 * server-side truncation warning.
 */

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('runs multiple statements sequentially and stops at the first error', async ({ page }) => {
  // Three statements; the 2nd references a missing table, so the 3rd must not run
  // (Hue-compatible stop-on-error, design.md §5).
  await setEditor(
    page,
    0,
    [
      'SELECT count(*) AS n FROM tpch.tiny.nation;',
      'SELECT * FROM tpch.tiny.does_not_exist;',
      'SELECT count(*) AS n FROM tpch.tiny.region;',
    ].join('\n'),
  );
  await runCell(page);

  // The cell settles on FAILED (the batch stopped at statement 2).
  await expect(cell(page).getByText('FAILED', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  const errorPanel = cell(page).getByTestId('error-panel');
  await expect(errorPanel).toBeVisible();
  await expect(errorPanel).toContainText(/does_not_exist/);
  // The region result (statement 3) never materialised — only 1 column of error
  // is shown, never region's single count column with a finished grid.
  await expect(cell(page).getByText('FINISHED', { exact: true })).toHaveCount(0);
});

test('cancels a heavy running query and lands in the canceled state', async ({ page }) => {
  // A cross join over a large tpch scale factor runs long enough to cancel
  // (design.md §5 キャンセル example).
  await setEditor(
    page,
    0,
    'SELECT count(*) FROM tpch.sf1000.lineitem CROSS JOIN tpch.tiny.nation',
  );
  // Turn auto-LIMIT off so the statement isn't reshaped (it's an aggregate anyway).
  await runCell(page);

  // It should be RUNNING; the Cancel button appears in the stats strip.
  const cancelBtn = cell(page).getByRole('button', { name: 'Cancel' });
  await expect(cancelBtn).toBeVisible({ timeout: 20_000 });
  await cancelBtn.click();

  // The cell settles to CANCELED and the cancel button disappears.
  await expect(cell(page).getByText('CANCELED', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(cancelBtn).toBeHidden();
});

test('runs EXPLAIN from the Explain tab and shows a distributed plan', async ({ page }) => {
  await setEditor(page, 0, 'SELECT regionkey, count(*) FROM tpch.tiny.nation GROUP BY regionkey');
  await runCell(page);
  await expectFinished(page);

  // Opening the Explain tab auto-triggers an EXPLAIN run for the caret statement.
  await openResultTab(page, 'Explain');
  const pane = resultPane(page);
  // The plan text mentions the distributed fragments / output stage.
  await expect(pane.locator('pre')).toBeVisible({ timeout: 30_000 });
  await expect(pane.locator('pre')).toContainText(/Fragment|Output|TableScan|Aggregate/i);
});

test('shows the truncated warning when the server caps the result', async ({ page }) => {
  // The playwright server runs with QUERY_MAX_ROWS=10000. Disable auto-LIMIT and
  // request 12000 rows so the buffer is capped and `truncated` is set.
  await cell(page).getByRole('switch', { name: 'Toggle auto LIMIT' }).click();
  await setEditor(page, 0, 'SELECT orderkey, partkey FROM tpch.tiny.lineitem LIMIT 12000');
  await runCell(page);
  await expectFinished(page);

  // The stats strip shows a "truncated" pill, and the grid footer warns too.
  await expect(cell(page).getByText('truncated', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await openResultTab(page, 'Grid');
  await expect(resultPane(page).getByText(/result truncated at the row cap/)).toBeVisible();
  // Only the cap was buffered client-side ("N loaded" in the grid toolbar), even
  // though the query reported more produced rows.
  await expect(resultPane(page).getByText(/10,000 loaded/)).toBeVisible();
});

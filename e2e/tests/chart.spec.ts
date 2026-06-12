import { test, expect, type Locator } from '@playwright/test';
import { resetWorkspace, setEditor, runCell, resultPane, expectFinished, waitGrid, openResultTab } from './helpers';

/**
 * Chart suite (design.md §5 結果 — チャート): a GROUP BY result rendered as a bar
 * chart, switched to a pie chart, with the ECharts canvas verified to have
 * actually painted (non-blank pixels), not merely mounted.
 */

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

/** True when the canvas has at least some non-transparent pixels (it painted). */
async function canvasHasPaint(canvas: Locator): Promise<boolean> {
  return canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const ctx = c.getContext('2d');
    if (!ctx || c.width === 0 || c.height === 0) return false;
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] !== 0) return true; // any non-transparent alpha
    }
    return false;
  });
}

test('renders a bar chart from a GROUP BY result and switches to pie', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT orderpriority, count(*) AS n FROM tpch.tiny.orders GROUP BY orderpriority ORDER BY orderpriority',
  );
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);

  // Open the Chart tab; the controls + canvas render.
  await openResultTab(page, 'Chart');
  const pane = resultPane(page);
  await expect(pane.getByTestId('chart-controls')).toBeVisible({ timeout: 20_000 });

  // Default is a bar chart — its canvas paints.
  const canvas = pane.getByTestId('chart-canvas').locator('canvas').first();
  await canvas.waitFor({ timeout: 20_000 });
  await expect.poll(async () => canvasHasPaint(canvas), { timeout: 15_000 }).toBe(true);

  // Switch to a pie chart via the type control; the canvas repaints.
  await pane.getByTestId('chart-controls').getByRole('button', { name: 'Pie' }).click();
  await expect(
    pane.getByTestId('chart-controls').getByRole('button', { name: 'Pie' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => canvasHasPaint(canvas), { timeout: 15_000 }).toBe(true);
});

test('chart config persists per cell across tab switches', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT orderpriority, count(*) AS n FROM tpch.tiny.orders GROUP BY orderpriority',
  );
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);

  await openResultTab(page, 'Chart');
  const pane = resultPane(page);
  const controls = pane.getByTestId('chart-controls');
  await expect(controls).toBeVisible({ timeout: 20_000 });
  // Pick Lines.
  await controls.getByRole('button', { name: 'Lines' }).click();
  await expect(controls.getByRole('button', { name: 'Lines' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // Switch to Grid and back — the Lines selection is retained (per-cell config).
  await openResultTab(page, 'Grid');
  await openResultTab(page, 'Chart');
  await expect(
    pane.getByTestId('chart-controls').getByRole('button', { name: 'Lines' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

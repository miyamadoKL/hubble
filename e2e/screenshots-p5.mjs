#!/usr/bin/env node
/*
 * P5 visual capture (design.md §9 screenshot gate). Drives Playwright against the
 * running dev stack — web (vite :5173, proxying /api → server :8081) with a live
 * Trino (tpch catalog) — to capture the six required P5 views:
 *
 *   p5-bar.png       — bar chart, two Y measures (count + sum) by orderpriority
 *   p5-pie.png       — pie chart of the same result
 *   p5-timeline.png  — line over a date X axis (revenue by orderdate)
 *   p5-scatter.png   — scatter (quantity vs extendedprice) with size column
 *   p5-dark.png      — a chart under the dark theme
 *   p5-shortcuts.png — the "Keyboard shortcuts" help modal
 *
 * Prereqs (start these first):
 *   - server: PORT=8081 TRINO_BASE_URL=http://localhost:30080 (live Trino)
 *   - web:    pnpm --filter @hubble/web dev   (vite :5173)
 *
 * Run: node e2e/screenshots-p5.mjs [baseURL]
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = resolve(repoRoot, 'docs/screenshots');

const BASE_URL = process.argv[2] ?? 'http://localhost:5173';
const VIEWPORT = { width: 1440, height: 900 };

async function resetWorkspace(page, mode = 'light') {
  await page.evaluate(
    ({ m }) => {
      /* eslint-disable no-undef */
      document.documentElement.setAttribute('data-theme', m);
      window.localStorage.setItem(
        'hubble-ui',
        JSON.stringify({
          state: { theme: m, sidebarTab: 'data', sidebarWidth: 300, sidebarCollapsed: false },
          version: 0,
        }),
      );
      window.localStorage.setItem(
        'hubble-recent-contexts',
        JSON.stringify([{ catalog: 'tpch', schema: 'sf1' }]),
      );
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('hubble-draft:') || key === 'hubble-workspace') {
          window.localStorage.removeItem(key);
        }
      }
      /* eslint-enable no-undef */
    },
    { m: mode },
  );
}

async function waitEditorReady(page, timeout = 20_000) {
  await page.locator('[data-testid="sql-editor"][data-ready="true"]').first().waitFor({ timeout });
}

async function setEditor(page, index, text) {
  await page.evaluate(
    ({ index, value }) => {
      /* eslint-disable no-undef */
      const editor = (window.__fableEditors ?? [])[index];
      if (!editor) throw new Error(`no editor #${index}`);
      editor.setValue(value);
      editor.focus();
      /* eslint-enable no-undef */
    },
    { index, value: text },
  );
}

/** Run the focused cell (Ctrl+Enter via the editor) and wait for the grid. */
async function runAndWaitGrid(page) {
  await page.locator('[data-testid="sql-editor"]').first().click();
  await page.keyboard.press('Control+Enter');
  // The result-pane tab may still be on a prior "Chart" selection — switch to Grid.
  await page.getByRole('tab', { name: 'Grid' }).first().click();
  await page.locator('[data-testid="result-grid"]').first().waitFor({ timeout: 30_000 });
  // Let the rows settle.
  await page.locator('text=/\\d+ rows · \\d+ columns/').first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(400);
}

async function openChartTab(page) {
  await page.getByRole('tab', { name: 'Chart' }).first().click();
  // The controls render even when the config needs a type/column choice; the
  // canvas may follow once the config is valid (picked via pickType).
  await page.locator('[data-testid="chart-controls"]').first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(400);
}

/** Pick a chart type by its control-row icon (aria-label), then await the canvas. */
async function pickType(page, label) {
  await page.locator('[data-testid="chart-controls"]').getByRole('button', { name: label }).click();
  await page.locator('[data-testid="chart-canvas"] canvas').first().waitFor({ timeout: 20_000 });
  await page.waitForTimeout(700);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: 'light',
  });
  const page = await context.newPage();

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await resetWorkspace(page, 'light');
    await page.reload({ waitUntil: 'networkidle' });
    await waitEditorReady(page);

    // ---- (a) Bar chart, two Y measures ----
    console.log('› (a) bar…');
    await setEditor(
      page,
      0,
      'SELECT orderpriority, count(*) c, sum(totalprice) s\nFROM tpch.sf1.orders\nGROUP BY orderpriority\nORDER BY orderpriority',
    );
    await runAndWaitGrid(page);
    await openChartTab(page);
    await page.locator('[data-testid="chart-canvas"] canvas').first().waitFor({ timeout: 20_000 });
    // Default seeds bars + the first numeric measure; add the second Y measure so
    // both `c` and `s` plot as series (design.md §6: 複数 Y 軸).
    await page
      .locator('[data-testid="chart-controls"]')
      .getByRole('button', { name: 'Y axis columns' })
      .click();
    await page.getByRole('option', { name: /^s/ }).click();
    // Close the multiselect popover (click the trigger again) so the chart is clean.
    await page
      .locator('[data-testid="chart-controls"]')
      .getByRole('button', { name: 'Y axis columns' })
      .click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(outDir, 'p5-bar.png') });

    // ---- (b) Pie of the same result ----
    console.log('› (b) pie…');
    await pickType(page, 'Pie');
    await page.screenshot({ path: resolve(outDir, 'p5-pie.png') });

    // ---- (c) Timeline (date X axis) ----
    console.log('› (c) timeline…');
    await setEditor(
      page,
      0,
      "SELECT orderdate, sum(totalprice) revenue\nFROM tpch.sf1.orders\nWHERE orderdate >= DATE '1995-01-01' AND orderdate < DATE '1995-04-01'\nGROUP BY orderdate\nORDER BY orderdate",
    );
    await runAndWaitGrid(page);
    await openChartTab(page);
    await pickType(page, 'Timeline');
    await page.screenshot({ path: resolve(outDir, 'p5-timeline.png') });

    // ---- (d) Scatter ----
    console.log('› (d) scatter…');
    await setEditor(
      page,
      0,
      'SELECT quantity, extendedprice, discount\nFROM tpch.sf1.lineitem\nLIMIT 2000',
    );
    await runAndWaitGrid(page);
    await openChartTab(page);
    await pickType(page, 'Scatter');
    // Set a size column (discount) for visual interest.
    await page
      .locator('[data-testid="chart-controls"]')
      .getByRole('button', { name: 'Scatter point-size column' })
      .click();
    await page.getByRole('option', { name: /discount/ }).click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(outDir, 'p5-scatter.png') });

    // ---- (e) Dark theme chart ----
    console.log('› (e) dark…');
    // Toggle the theme via the keyboard shortcut so the store + chart re-theme.
    await page.keyboard.press('Control+Alt+t');
    await page.waitForTimeout(900);
    await pickType(page, 'Bars');
    await page.screenshot({ path: resolve(outDir, 'p5-dark.png') });

    // ---- (f) Keyboard shortcuts help modal ----
    console.log('› (f) shortcuts…');
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 5000 });
    await page.locator('input[placeholder="Type a command…"]').fill('keyboard');
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: 'Keyboard shortcuts' }).waitFor({ timeout: 5000 });
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(outDir, 'p5-shortcuts.png') });

    console.log(`✓ Screenshots written to ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/*
 * P3b visual capture (design.md §9 screenshot gate). Drives Playwright against
 * the running dev stack — web (vite :5173, proxying /api → server :8081) with a
 * live Trino (tpch catalog) behind it — to capture the five required execution
 * + result-grid views:
 *
 *   p3b-running.png  — a query mid-flight (running progress + gutter spinner)
 *   p3b-grid.png     — finished result grid (real rows, virtual scroll, stats)
 *   p3b-agg.png      — a finished GROUP BY aggregation
 *   p3b-error.png    — execution error (missing table): error panel + marker
 *   p3b-explain.png  — the EXPLAIN tab plan
 *
 * Prereqs (start these first):
 *   - server: PORT=8081 TRINO_BASE_URL=http://localhost:30080 (P2a, live Trino)
 *   - web:    pnpm --filter @hue-fable/web dev   (vite :5173)
 *
 * Run: node e2e/screenshots-p3b.mjs
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = resolve(repoRoot, 'docs/screenshots');

const BASE_URL = 'http://localhost:5173';
const VIEWPORT = { width: 1440, height: 900 };

async function setTheme(page, mode) {
  await page.evaluate((m) => {
    /* eslint-disable no-undef */
    document.documentElement.setAttribute('data-theme', m);
    window.localStorage.setItem(
      'hue-fable-ui',
      JSON.stringify({
        state: { theme: m, sidebarTab: 'data', sidebarWidth: 288, sidebarCollapsed: false },
        version: 0,
      }),
    );
    /* eslint-enable no-undef */
  }, mode);
}

/** Set the first Monaco editor's content via the dev-only model hook. */
async function setEditorContent(page, text) {
  await page.evaluate((value) => {
    /* eslint-disable no-undef */
    const editor = (window.__fableEditors ?? [])[0];
    if (!editor) throw new Error('no editor registered');
    editor.setValue(value);
    const model = editor.getModel();
    const last = model.getLineCount();
    editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
    editor.focus();
    /* eslint-enable no-undef */
  }, text);
}

const runButton = (page) => page.getByRole('button', { name: 'Run cell', exact: true }).first();

/** Wait until the result pane shows a finished grid (row count footer). */
async function waitForGrid(page, timeout = 30_000) {
  await page.locator('[data-testid="result-grid"]').first().waitFor({ timeout });
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
    await setTheme(page, 'light');
    await page.reload({ waitUntil: 'networkidle' });
    await page
      .locator('[data-testid="sql-editor"][data-ready="true"]')
      .first()
      .waitFor({ timeout: 20_000 });

    // (a) Running — a large scan that streams long enough to catch in flight.
    // We disable auto-LIMIT (toggle off) so the full scan runs.
    console.log('› (a) running…');
    await setEditorContent(page, 'SELECT * FROM tpch.sf100.orders');
    // Turn auto-LIMIT off so the query keeps running (5000-row cap would finish
    // almost instantly). Toggle the LIMIT switch in the cell toolbar.
    await page.getByRole('switch', { name: 'Toggle auto LIMIT' }).first().click();
    await runButton(page).click();
    // Poll briefly for the RUNNING badge, then snapshot mid-flight.
    await page
      .getByText('RUNNING', { exact: true })
      .first()
      .waitFor({ timeout: 15_000 })
      .catch(() => {});
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(outDir, 'p3b-running.png') });
    // Cancel so the heavy scan stops streaming.
    await page.getByRole('button', { name: 'Stop' }).first().click().catch(() => {});
    await page.waitForTimeout(400);

    // (b) Finished grid — a bounded scan (auto-LIMIT back on).
    console.log('› (b) grid…');
    await page.getByRole('switch', { name: 'Toggle auto LIMIT' }).first().click(); // re-enable
    await setEditorContent(page, 'SELECT * FROM tpch.sf1.orders');
    await runButton(page).click();
    await waitForGrid(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(outDir, 'p3b-grid.png') });

    // (c) Aggregation — GROUP BY count, finished.
    console.log('› (c) aggregation…');
    await setEditorContent(
      page,
      'SELECT count(*) AS orders, orderstatus\nFROM tpch.sf1.orders\nGROUP BY orderstatus',
    );
    await runButton(page).click();
    await waitForGrid(page);
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(outDir, 'p3b-agg.png') });

    // (d) Execution error — a missing table triggers the error panel + marker.
    console.log('› (d) error…');
    await setEditorContent(page, 'SELECT * FROM tpch.sf1.no_such_table');
    await runButton(page).click();
    await page.locator('[data-testid="error-panel"]').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(700);
    await page.screenshot({ path: resolve(outDir, 'p3b-error.png') });

    // (e) EXPLAIN tab — run a plan on the current statement.
    console.log('› (e) explain…');
    await setEditorContent(page, 'SELECT orderstatus, count(*) FROM tpch.sf1.orders GROUP BY orderstatus');
    await runButton(page).click();
    await waitForGrid(page);
    // Open the Explain tab (auto-runs EXPLAIN on first open).
    await page.getByRole('tab', { name: 'Explain' }).first().click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: resolve(outDir, 'p3b-explain.png') });

    console.log(`✓ Screenshots written to ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

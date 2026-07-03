#!/usr/bin/env node
/*
 * P4a visual capture (design.md §9 screenshot gate). Drives Playwright against
 * the running dev stack — web (vite, proxying /api → server :8081) with a live
 * Trino (tpch catalog) — to capture the five required notebook-core views:
 *
 *   p4a-variables.png  — a notebook with the variable panel, a ${status} select
 *                        and ${n} number filled in and the query executed
 *   p4a-markdown.png    — a markdown cell in edit mode (mono textarea) beside a
 *                        rendered one
 *   p4a-reorder.png     — cells mid-reorder (drag indicator / move affordance)
 *   p4a-save.png        — the save-notebook modal (name input)
 *   p4a-tabs.png        — multiple notebook tabs with a dirty indicator
 *
 * Prereqs (start these first):
 *   - server: PORT=8081 (live Trino at :30080)
 *   - web:    pnpm --filter @hubble/web dev
 *
 * Run: node e2e/screenshots-p4a.mjs [baseURL]
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
  await page.evaluate((m) => {
    /* eslint-disable no-undef */
    document.documentElement.setAttribute('data-theme', m);
    window.localStorage.setItem(
      'hubble-ui',
      JSON.stringify({
        state: { theme: m, sidebarTab: 'data', sidebarWidth: 288, sidebarCollapsed: false },
        version: 0,
      }),
    );
    // Clear any restored workspace / drafts so each run starts clean.
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith('hubble-draft:') || key === 'hubble-workspace') {
        window.localStorage.removeItem(key);
      }
    }
    /* eslint-enable no-undef */
  }, mode);
}

/** Set the Nth Monaco editor's content via the dev-only model hook. */
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

async function waitEditorReady(page, timeout = 20_000) {
  await page.locator('[data-testid="sql-editor"][data-ready="true"]').first().waitFor({ timeout });
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

    // ---- (a) Variable panel + executed query ----
    console.log('› (a) variables…');
    await setEditor(
      page,
      0,
      "SELECT orderkey, orderstatus, totalprice\nFROM tpch.tiny.orders\nWHERE orderstatus = '${status=O,F,P}'\nLIMIT ${n=10}",
    );
    // The variable panel appears once detection runs (debounced via store).
    await page.locator('[data-testid="variable-panel"]').waitFor({ timeout: 10_000 });
    // Fill the number variable to 8 and pick status F.
    await page
      .locator('#var-status')
      .selectOption('F')
      .catch(() => {});
    await page
      .locator('#var-n')
      .fill('8')
      .catch(() => {});
    // Run the cell.
    await page.getByRole('button', { name: 'Run cell', exact: true }).first().click();
    await page.locator('[data-testid="result-grid"]').first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(600);
    await page.screenshot({ path: resolve(outDir, 'p4a-variables.png') });

    // ---- (b) Markdown cell edit mode ----
    console.log('› (b) markdown…');
    // Add a markdown cell via the command palette → "New Markdown cell".
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Type a command…').fill('Markdown');
    await page.getByText('New Markdown cell').first().click();
    await page.waitForTimeout(300);
    // Click the new (empty) markdown cell to enter edit mode.
    await page.getByRole('button', { name: 'Edit markdown' }).last().click();
    const mdArea = page.getByLabel('Markdown source').first();
    await mdArea.waitFor({ timeout: 5000 });
    await mdArea.fill(
      '## Order status review\n\nThis notebook filters **tpch.tiny.orders** by a `${status}` variable.\n\n- `O` — open\n- `F` — fulfilled\n- `P` — in process\n\n| status | meaning |\n| --- | --- |\n| O | open |\n| F | fulfilled |\n\n```sql\nSELECT * FROM tpch.tiny.orders\n```',
    );
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(outDir, 'p4a-markdown.png') });
    // Commit the markdown so it renders (for later shots).
    await page.keyboard.press('Control+Enter');
    await page.waitForTimeout(300);

    // ---- (c) Cell reorder affordance ----
    console.log('› (c) reorder…');
    // Add a second SQL cell so there is something to reorder.
    await page.keyboard.press('Control+k');
    await page.getByPlaceholder('Type a command…').fill('New SQL');
    await page.getByText('New SQL cell').first().click();
    await page.waitForTimeout(300);
    // Hover the first cell's drag grip to surface the reorder affordance, and
    // hover a move button so the tooltip shows the move action.
    const firstCell = page.locator('[data-testid="notebook-cell"]').first();
    await firstCell.getByRole('button', { name: 'Move down' }).hover();
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(outDir, 'p4a-reorder.png') });

    // ---- (d) Save modal ----
    console.log('› (d) save…');
    await page.keyboard.press('Control+s');
    await page.getByLabel('Notebook name').waitFor({ timeout: 5000 });
    await page.getByLabel('Notebook name').fill('Order status review');
    await page.waitForTimeout(300);
    await page.screenshot({ path: resolve(outDir, 'p4a-save.png') });
    // Confirm the save (the dialog's Save button) so the draft becomes saved.
    await page
      .getByLabel('Save notebook')
      .getByRole('button', { name: 'Save', exact: true })
      .click();
    await page.waitForTimeout(1000);

    // ---- (e) Multiple tabs + dirty indicator ----
    console.log('› (e) tabs…');
    // New notebook → a second tab.
    await page.getByRole('button', { name: 'New notebook' }).click();
    await waitEditorReady(page);
    // Make an edit on the new notebook's cell so its tab shows the dirty dot.
    await page.evaluate(() => {
      /* eslint-disable no-undef */
      const editors = window.__fableEditors ?? [];
      const ed = editors[editors.length - 1];
      if (ed) {
        ed.setValue('SELECT count(*) FROM tpch.tiny.nation');
        ed.focus();
      }
      /* eslint-enable no-undef */
    });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(outDir, 'p4a-tabs.png') });

    console.log(`✓ Screenshots written to ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

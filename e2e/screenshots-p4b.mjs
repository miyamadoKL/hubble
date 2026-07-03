#!/usr/bin/env node
/*
 * P4b visual capture (design.md §9 screenshot gate). Drives Playwright against
 * the running dev stack — web (vite :5173, proxying /api → server :8081) with a
 * live Trino (tpch catalog) — to capture the five required assist-panel views:
 *
 *   p4b-tree.png      — Data browser tree expanded to tpch.tiny.orders columns
 *                       (types shown), with a column inserted into the cell
 *   p4b-detail.png    — table detail popover (columns + 10 sample rows)
 *   p4b-history.png   — History panel with real data (failed + finished mix)
 *   p4b-context.png   — context selector dropdown open (catalogs + schemas)
 *   p4b-saved.png     — Saved queries panel (2+ saved, one favorited)
 *
 * Prereqs (start these first):
 *   - server: PORT=8081 TRINO_BASE_URL=http://localhost:30080 (live Trino)
 *   - web:    pnpm --filter @hubble/web dev   (vite :5173)
 *
 * Run: node e2e/screenshots-p4b.mjs [baseURL]
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = resolve(repoRoot, 'docs/screenshots');

const BASE_URL = process.argv[2] ?? 'http://localhost:5173';
const API = `${BASE_URL}/api`;
const VIEWPORT = { width: 1440, height: 900 };

async function resetWorkspace(page, mode = 'light', sidebarTab = 'data') {
  await page.evaluate(
    ({ m, tab }) => {
      /* eslint-disable no-undef */
      document.documentElement.setAttribute('data-theme', m);
      window.localStorage.setItem(
        'hubble-ui',
        JSON.stringify({
          state: { theme: m, sidebarTab: tab, sidebarWidth: 320, sidebarCollapsed: false },
          version: 0,
        }),
      );
      // Seed a recent context so the selector + new notebooks default to tpch.tiny.
      window.localStorage.setItem(
        'hubble-recent-contexts',
        JSON.stringify([{ catalog: 'tpch', schema: 'tiny' }]),
      );
      for (const key of Object.keys(window.localStorage)) {
        if (key.startsWith('hubble-draft:') || key === 'hubble-workspace') {
          window.localStorage.removeItem(key);
        }
      }
      /* eslint-enable no-undef */
    },
    { m: mode, tab: sidebarTab },
  );
}

async function setEditor(page, index, text) {
  await page.evaluate(
    ({ index, value }) => {
      /* eslint-disable no-undef */
      const editor = (window.__fableEditors ?? [])[index];
      if (!editor) throw new Error(`no editor #${index}`);
      editor.setValue(value);
      const model = editor.getModel();
      const last = model.getLineCount();
      editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
      editor.focus();
      /* eslint-enable no-undef */
    },
    { index, value: text },
  );
}

async function waitEditorReady(page, timeout = 20_000) {
  await page.locator('[data-testid="sql-editor"][data-ready="true"]').first().waitFor({ timeout });
}

/** Seed two saved queries (one favorited) via the API so the panel has content. */
async function seedSavedQueries(request) {
  const existing = await request.get(`${API}/saved-queries`).then((r) => r.json());
  const names = new Set((existing ?? []).map((q) => q.name));
  const want = [
    {
      name: 'Revenue by segment',
      description: 'Gross revenue grouped by market segment.',
      statement:
        'SELECT c.mktsegment, sum(o.totalprice) AS revenue\nFROM tpch.tiny.orders o\nJOIN tpch.tiny.customer c ON c.custkey = o.custkey\nGROUP BY 1\nORDER BY revenue DESC',
      catalog: 'tpch',
      schema: 'tiny',
      isFavorite: true,
    },
    {
      name: 'Late shipments by mode',
      description: 'Line items where receipt slipped past commit date.',
      statement:
        'SELECT shipmode, count(*) AS late\nFROM tpch.tiny.lineitem\nWHERE receiptdate > commitdate\nGROUP BY shipmode\nORDER BY late DESC',
      catalog: 'tpch',
      schema: 'tiny',
      isFavorite: false,
    },
    {
      name: 'Top customers',
      description: 'Customers ranked by total order value.',
      statement:
        'SELECT c.name, sum(o.totalprice) AS spend\nFROM tpch.tiny.orders o\nJOIN tpch.tiny.customer c ON c.custkey = o.custkey\nGROUP BY 1\nORDER BY spend DESC\nLIMIT 50',
      catalog: 'tpch',
      schema: 'tiny',
      isFavorite: false,
    },
  ];
  for (const sq of want) {
    if (!names.has(sq.name)) {
      await request.post(`${API}/saved-queries`, { data: sq });
    }
  }
}

/** Run a statement to completion (or failure) so it lands in history. */
async function runToHistory(request, statement, catalog = 'tpch', schema = 'tiny') {
  const res = await request.post(`${API}/queries`, {
    data: { statement, catalog, schema, source: 'hubble' },
  });
  const { queryId } = await res.json();
  // Poll the snapshot until it settles.
  for (let i = 0; i < 60; i++) {
    const snap = await request.get(`${API}/queries/${queryId}`).then((r) => r.json());
    if (['finished', 'failed', 'canceled'].includes(snap.state)) return snap.state;
    await new Promise((r) => setTimeout(r, 250));
  }
  return 'timeout';
}

async function seedHistory(request) {
  // A couple of clean finishes…
  await runToHistory(request, 'SELECT count(*) FROM tpch.tiny.orders');
  await runToHistory(
    request,
    'SELECT orderstatus, count(*) FROM tpch.tiny.orders GROUP BY orderstatus',
  );
  await runToHistory(request, 'SELECT * FROM tpch.tiny.nation ORDER BY name LIMIT 25');
  // …and a deliberate failure (typo'd keyword + missing table).
  await runToHistory(request, 'SELCT * FROM tpch.tiny.ordrs');
  await runToHistory(request, 'SELECT * FROM tpch.tiny.does_not_exist');
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

  // Seed server-side data first (saved queries + history) via the proxied API.
  console.log('› seeding saved queries + history…');
  await seedSavedQueries(context.request);
  await seedHistory(context.request);

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await resetWorkspace(page, 'light', 'data');
    await page.reload({ waitUntil: 'networkidle' });
    await waitEditorReady(page);

    // ---- (a) Data tree expanded to columns + a column inserted ----
    console.log('› (a) tree…');
    // Expand tpch → tiny → orders by clicking the chevrons/rows.
    await page.getByRole('button', { name: /^tpch/ }).first().click();
    await page.getByRole('button', { name: /^tiny/ }).first().click();
    await page
      .getByRole('button', { name: /^orders/ })
      .first()
      .click();
    // Wait for columns of orders to appear (types rendered to the right).
    await page.locator('text=orderkey').first().waitFor({ timeout: 15_000 });
    // Click a column to insert it into the focused cell, after seeding the caret.
    await setEditor(page, 0, 'SELECT \nFROM tpch.tiny.orders');
    await page.evaluate(() => {
      /* eslint-disable no-undef */
      const ed = (window.__fableEditors ?? [])[0];
      ed.setPosition({ lineNumber: 1, column: 8 });
      ed.focus();
      /* eslint-enable no-undef */
    });
    await page.locator('text=totalprice').first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(outDir, 'p4b-tree.png') });

    // ---- (b) Table detail popover (columns + sample rows) ----
    console.log('› (b) detail popover…');
    await page.getByRole('button', { name: 'Details for orders' }).first().click();
    // Wait for the sample table to populate.
    await page.getByRole('dialog', { name: /orders details/ }).waitFor({ timeout: 10_000 });
    await page.locator('text=Sample · 10 rows').waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(outDir, 'p4b-detail.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);

    // ---- (c) History panel (failed + finished mix) ----
    console.log('› (c) history…');
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await page.locator('text=FINISHED').first().waitFor({ timeout: 15_000 });
    await page.locator('text=FAILED').first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(outDir, 'p4b-history.png') });

    // ---- (d) Context selector dropdown open ----
    console.log('› (d) context…');
    await page.getByRole('button', { name: 'catalog.schema context' }).click();
    await page.getByRole('dialog', { name: 'Select context' }).waitFor({ timeout: 5000 });
    // Hover tpch to populate the schema pane.
    await page.locator('[role="dialog"] >> text=tpch').first().hover();
    await page.waitForTimeout(500);
    await page.screenshot({ path: resolve(outDir, 'p4b-context.png') });
    await page.keyboard.press('Escape');

    // ---- (e) Saved queries panel ----
    console.log('› (e) saved…');
    await page.getByRole('button', { name: 'Saved', exact: true }).click();
    await page.locator('text=Revenue by segment').first().waitFor({ timeout: 10_000 });
    // Expand the first one to show the statement + actions.
    await page.locator('text=Revenue by segment').first().click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(outDir, 'p4b-saved.png') });

    console.log(`✓ Screenshots written to ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

#!/usr/bin/env node
/*
 * P3a visual capture (design.md §9 screenshot gate). Drives Playwright against
 * the running dev stack — web (vite :5173, proxying /api → server :8081) with a
 * live Trino behind it — to capture the four required editor views:
 *
 *   p3a-highlight.png   — a SQL cell with Trino ANTLR highlighting
 *   p3a-completion.png  — completion popup after `... FROM tpch.tiny.` + Ctrl+Space
 *   p3a-error.png       — syntax-error marker (squiggle) with the hover message
 *   p3a-dark.png        — the editor under the dark theme
 *
 * Prereqs (start these first):
 *   - server: PORT=8081 (P2a build, live Trino): データソーススコープ付きメタデータルートを提供
 *   - web:    pnpm --filter @hubble/web dev   (vite :5173)
 *
 * Run: node e2e/screenshots-p3a.mjs
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

const SAMPLE_SQL = [
  '-- Trino SQL: live highlighting, completion and error markers',
  'SELECT',
  '  o.orderkey,',
  '  o.totalprice,',
  '  c.name AS customer',
  'FROM tpch.tiny.orders AS o',
  'JOIN tpch.tiny.customer AS c ON c.custkey = o.custkey',
  "WHERE o.orderstatus = 'O'",
  'ORDER BY o.totalprice DESC',
  'LIMIT 100',
].join('\n');

async function setTheme(page, mode) {
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
    /* eslint-enable no-undef */
  }, mode);
}

/**
 * Set the first Monaco editor's content via the model (the dev-only
 * `window.__fableEditors` hook), then move the caret to the end. Avoids the
 * scrambling that multi-line keyboard typing causes (auto-indent + suggest).
 */
async function setEditorContent(page, text) {
  await page.evaluate((value) => {
    /* eslint-disable no-undef */
    const editors = window.__fableEditors ?? [];
    const editor = editors[0];
    if (!editor) throw new Error('no editor registered');
    editor.setValue(value);
    const model = editor.getModel();
    const last = model.getLineCount();
    editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
    editor.focus();
    /* eslint-enable no-undef */
  }, text);
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

    // Wait for the lazily-loaded Monaco editor to mount.
    await page.locator('[data-testid="sql-editor"][data-ready="true"]').first().waitFor({
      timeout: 20_000,
    });

    // (a) Highlighting — set a rich query and let tokenizer/decorations settle.
    console.log('› (a) highlight…');
    await setEditorContent(page, SAMPLE_SQL);
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(outDir, 'p3a-highlight.png') });

    // (b) Completion popup after `FROM ` + Ctrl+Space. The first trigger fires
    // the lazy table-metadata fetch; after it resolves, a second trigger shows
    // the table names alongside the keyword candidates.
    console.log('› (b) completion…');
    await setEditorContent(page, 'SELECT * FROM ');
    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(1600); // let the table list resolve
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    // Re-trigger via the editor command so focus is guaranteed on the editor.
    await page.evaluate(() => {
      /* eslint-disable no-undef */
      const editor = window.__fableEditors?.[0];
      editor?.focus();
      editor?.trigger('screenshot', 'editor.action.triggerSuggest', {});
      /* eslint-enable no-undef */
    });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(outDir, 'p3a-completion.png') });
    await page.keyboard.press('Escape');

    // (c) Syntax-error marker + hover. `SELECT FROM` squiggles the FROM token.
    console.log('› (c) error marker + hover…');
    await setEditorContent(page, 'SELECT FROM tpch.tiny.orders');
    await page.waitForTimeout(700); // 200ms debounce + render
    // Hover the squiggled `FROM` (line 1). Find its screen position via Monaco.
    const fromBox = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const el = document.querySelector('.squiggly-error') || document.querySelector('.cdr');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      /* eslint-enable no-undef */
    });
    if (fromBox) {
      await page.mouse.move(fromBox.x, fromBox.y);
      await page.waitForTimeout(900);
    }
    await page.screenshot({ path: resolve(outDir, 'p3a-error.png') });

    // (d) Dark theme editor. Move the mouse off the editor so no stale hover
    // lingers, set a clean (valid) query, then switch the theme.
    console.log('› (d) dark…');
    await page.mouse.move(VIEWPORT.width - 40, VIEWPORT.height - 40);
    await page.keyboard.press('Escape');
    await setEditorContent(page, SAMPLE_SQL);
    await setTheme(page, 'dark');
    await page.waitForTimeout(900);
    await page.screenshot({ path: resolve(outDir, 'p3a-dark.png') });

    console.log(`✓ Screenshots written to ${outDir}`);
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

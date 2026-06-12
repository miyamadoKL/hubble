#!/usr/bin/env node
/*
 * Visual capture script (design.md §9 screenshot gate). Builds the web app,
 * serves it with `vite preview`, then drives Playwright to capture the four
 * required 1440×900 views into docs/screenshots/:
 *
 *   p2b-light.png   — default light theme, app shell
 *   p2b-dark.png    — dark theme
 *   p2b-palette.png — command palette open (Ctrl+K)
 *   p2b-history.png — sidebar History tab
 *
 * Reusable: run `node e2e/screenshots.mjs` from the repo root (or e2e/). The
 * web app is self-contained on mock data, so no server is needed.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const webDir = resolve(repoRoot, 'packages/web');
const outDir = resolve(repoRoot, 'docs/screenshots');

const PORT = 4317;
const BASE_URL = `http://localhost:${PORT}`;
const VIEWPORT = { width: 1440, height: 900 };

function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
    child.on('error', rej);
  });
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  // 1. Build (ensures the captured app matches `pnpm --filter web build`).
  console.log('› Building web app…');
  await run('pnpm', ['--filter', '@hubble/web', 'build'], { cwd: repoRoot });

  // 2. Serve the production build.
  console.log('› Starting vite preview…');
  const preview = spawn(
    'pnpm',
    ['exec', 'vite', 'preview', '--port', String(PORT), '--strictPort'],
    { cwd: webDir, stdio: 'inherit' },
  );

  let browser;
  try {
    await waitForServer(BASE_URL);

    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const page = await context.newPage();

    const setTheme = (mode) =>
      // This callback executes in the browser context (document/window are the
      // page's globals, not Node's).
      page.evaluate((m) => {
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

    const settle = () => page.waitForTimeout(400);

    // (a) Light theme — default shell.
    console.log('› Capturing light…');
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await setTheme('light');
    await settle();
    await page.screenshot({ path: resolve(outDir, 'p2b-light.png') });

    // (b) Dark theme.
    console.log('› Capturing dark…');
    await setTheme('dark');
    await settle();
    await page.screenshot({ path: resolve(outDir, 'p2b-dark.png') });

    // (c) Command palette open (back on light for contrast).
    console.log('› Capturing palette…');
    await setTheme('light');
    await settle();
    await page.keyboard.press('Control+k');
    await settle();
    await page.screenshot({ path: resolve(outDir, 'p2b-palette.png') });
    await page.keyboard.press('Escape');

    // (d) Sidebar History tab.
    console.log('› Capturing history…');
    await page.getByRole('button', { name: 'History', exact: true }).first().click();
    await settle();
    await page.screenshot({ path: resolve(outDir, 'p2b-history.png') });

    console.log(`✓ Screenshots written to ${outDir}`);
  } finally {
    if (browser) await browser.close();
    preview.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import { test, expect } from '@playwright/test';
import yauzl from 'yauzl';
import {
  resetWorkspace,
  setEditor,
  cell,
  runCell,
  resultPane,
  expectFinished,
  waitGrid,
} from './helpers';

/** Read all entries of a zip file from disk into a name -> bytes map. */
function readZip(path: string): Promise<Record<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true }, (err, zipfile) => {
      if (err || !zipfile) return reject(err ?? new Error('no zipfile'));
      const out: Record<string, Buffer> = {};
      zipfile.on('entry', (entry) => {
        zipfile.openReadStream(entry, (e, rs) => {
          if (e || !rs) return reject(e ?? new Error('no read stream'));
          const chunks: Buffer[] = [];
          rs.on('data', (d) => chunks.push(d as Buffer));
          rs.on('end', () => {
            out[entry.fileName] = Buffer.concat(chunks);
            zipfile.readEntry();
          });
          rs.on('error', reject);
        });
      });
      zipfile.on('end', () => resolve(out));
      zipfile.on('error', reject);
      zipfile.readEntry();
    });
  });
}

/**
 * Results suite (design.md §5 結果): virtual scroll over 5000 rows, column show/
 * hide, sort, cell-value filter, CSV download (content verified), and clipboard
 * copy.
 */

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('virtual-scrolls a 5000-row result without rendering every row', async ({ page }) => {
  await cell(page).getByRole('switch', { name: 'Toggle auto LIMIT' }).click(); // disable auto-LIMIT
  await setEditor(
    page,
    0,
    'SELECT orderkey, partkey, quantity, extendedprice FROM tpch.tiny.lineitem ORDER BY orderkey, partkey LIMIT 5000',
  );
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);

  const pane = resultPane(page);
  await expect(pane.getByText(/5,000 rows · 4 columns/)).toBeVisible();

  const grid = pane.getByTestId('result-grid');
  // Virtualization: far fewer DOM rows than 5000 are present (overscan window).
  const renderedBefore = await grid.locator('.group.absolute.grid').count();
  expect(renderedBefore).toBeLessThan(200);

  // Scroll to the bottom; the last source row (#5000) becomes reachable.
  await grid.evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
  await expect(grid.getByText('5000', { exact: true }).first()).toBeVisible({ timeout: 10_000 });
  // Still virtualized after scrolling.
  const renderedAfter = await grid.locator('.group.absolute.grid').count();
  expect(renderedAfter).toBeLessThan(200);
});

test('hides and shows a column via the column menu', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT nationkey, name, regionkey FROM tpch.tiny.nation ORDER BY nationkey',
  );
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);

  const grid = resultPane(page).getByTestId('result-grid');
  const header = cell(page).locator('.sticky.top-0'); // grid header row
  await expect(header.getByText('name', { exact: true })).toBeVisible();

  // Open the column menu and untick "name".
  await cell(page).getByRole('button', { name: 'Show / hide columns' }).click();
  await page.getByRole('checkbox').filter({ has: page.locator(':scope') });
  const nameRow = page.locator('label', { hasText: 'name' }).first();
  await nameRow.getByRole('checkbox').uncheck();
  // Close the menu by clicking the backdrop.
  await page.keyboard.press('Escape');

  // "name" column header is gone from the grid; the other two remain.
  await expect(header.getByText('name', { exact: true })).toBeHidden();
  await expect(header.getByText('nationkey', { exact: true })).toBeVisible();
  await expect(grid.getByText('ALGERIA')).toHaveCount(0);
});

test('sorts by a column header (asc → desc → none)', async ({ page }) => {
  await setEditor(page, 0, 'SELECT nationkey, name FROM tpch.tiny.nation');
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);

  const grid = resultPane(page).getByTestId('result-grid');
  // Sort ascending by name → ALGERIA (alphabetically first) is the first data row.
  await cell(page).getByRole('button', { name: /^name/ }).click();

  // The first rendered data row should now contain ALGERIA.
  const firstRow = grid.locator('.group.absolute.grid').first();
  await expect(firstRow).toContainText('ALGERIA', { timeout: 10_000 });

  // Sort descending → VIETNAM (alphabetically last) leads.
  await cell(page).getByRole('button', { name: /^name/ }).click();
  await expect(grid.locator('.group.absolute.grid').first()).toContainText('VIETNAM', {
    timeout: 10_000,
  });
});

test('filters loaded rows by a cell value', async ({ page }) => {
  await setEditor(page, 0, 'SELECT nationkey, name FROM tpch.tiny.nation');
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);

  const pane = resultPane(page);
  await cell(page).getByRole('button', { name: 'Filter rows' }).click();
  const filterInput = cell(page).getByRole('textbox', { name: 'Filter rows' });
  await filterInput.fill('CHINA');

  // The "N / 25 loaded" counter reflects a single match.
  await expect(pane.getByText(/^1 \/ /)).toBeVisible({ timeout: 10_000 });
  const grid = pane.getByTestId('result-grid');
  await expect(grid.getByText('CHINA')).toBeVisible();
  await expect(grid.getByText('FRANCE')).toHaveCount(0);
});

test('downloads CSV and the file content starts with the header row', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT nationkey, name FROM tpch.tiny.nation ORDER BY nationkey LIMIT 3',
  );
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);

  // Default download is zip; pick "Plain .csv" to get an uncompressed file.
  await resultPane(page).getByRole('button', { name: 'Download format' }).click();
  await page.getByRole('option', { name: 'Plain .csv' }).click();

  const downloadPromise = page.waitForEvent('download');
  // The CSV link is an <a download> in the result-pane toolbar.
  await resultPane(page).getByRole('link', { name: /CSV/ }).click();
  const download = await downloadPromise;

  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  const firstLine = text.split(/\r?\n/)[0]!;
  expect(firstLine).toBe('nationkey,name');
  // First data row is ALGERIA (nationkey 0).
  expect(text).toContain('0,ALGERIA');
});

test('downloads a zip whose single .csv entry has the header row', async ({ page }) => {
  await setEditor(
    page,
    0,
    'SELECT nationkey, name FROM tpch.tiny.nation ORDER BY nationkey LIMIT 3',
  );
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);

  // Zip is the default format; click the download link directly.
  const downloadPromise = page.waitForEvent('download');
  await resultPane(page)
    .getByRole('link', { name: /CSV \(zip\)/ })
    .click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.zip$/);

  const path = await download.path();
  const entries = await readZip(path);
  const names = Object.keys(entries);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/\.csv$/);
  const text = entries[names[0]!]!.toString('utf8');
  expect(text.split(/\r?\n/)[0]).toBe('nationkey,name');
  expect(text).toContain('0,ALGERIA');
});

test('copies the result to the clipboard as TSV', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await setEditor(
    page,
    0,
    'SELECT nationkey, name FROM tpch.tiny.nation ORDER BY nationkey LIMIT 2',
  );
  await runCell(page);
  await expectFinished(page);
  await waitGrid(page);

  await resultPane(page).getByRole('button', { name: 'Copy as TSV + HTML' }).click();
  // The button flips to "Copied" on success.
  await expect(resultPane(page).getByRole('button', { name: 'Copied' })).toBeVisible({
    timeout: 5000,
  });

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  // Tab-separated header + first row.
  expect(clip).toContain('nationkey\tname');
  expect(clip).toContain('0\tALGERIA');
});

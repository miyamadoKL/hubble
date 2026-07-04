import { test, expect } from '@playwright/test';
import { resetWorkspace, setEditor, waitEditorReady } from './helpers';

/**
 * App-shell suite: theme toggle persistence,
 * command-palette navigation, the keyboard-shortcuts help modal, and presentation
 * mode.
 */

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('toggles the theme and persists it across a reload', async ({ page }) => {
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'light');

  // Ctrl+Alt+T toggles to dark.
  await page.keyboard.press('Control+Alt+KeyT');
  await expect(root).toHaveAttribute('data-theme', 'dark');

  // Reload — the dark preference is restored from localStorage.
  await page.reload();
  await waitEditorReady(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('navigates the sidebar from the command palette', async ({ page }) => {
  // Ctrl+K → "Go to History" focuses the History panel.
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Type a command…');
  await expect(input).toBeVisible();
  await input.fill('Go to History');
  await page
    .getByRole('dialog', { name: 'Command palette' })
    .getByText('Go to History')
    .first()
    .click();

  // The History panel is now the active sidebar section.
  await expect(page.getByRole('heading', { name: 'History', level: 2 })).toBeVisible({
    timeout: 10_000,
  });
});

test('opens the keyboard-shortcuts help modal from the palette', async ({ page }) => {
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Type a command…');
  await input.fill('Keyboard shortcuts');
  await page
    .getByRole('dialog', { name: 'Command palette' })
    .getByText('Keyboard shortcuts')
    .first()
    .click();

  const help = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(help).toBeVisible();
  // It lists the canonical shortcuts (run / palette / theme).
  await expect(help.getByText('Run the active cell')).toBeVisible();
  await expect(help.getByText('Command palette')).toBeVisible();
  await expect(help.getByText('Toggle light / dark theme')).toBeVisible();
});

test('enters and exits presentation mode', async ({ page }) => {
  // Author a notebook with a heading comment + markdown so cards render.
  await setEditor(page, 0, '-- Sales overview\nSELECT count(*) FROM tpch.tiny.orders');

  // Ctrl+Shift+P enters presentation mode (full-bleed cards).
  await page.keyboard.press('Control+Shift+KeyP');
  const view = page.getByTestId('presentation-view');
  await expect(view).toBeVisible();
  await expect(view.getByText('Presentation')).toBeVisible();
  // The `-- heading` becomes a card title.
  await expect(view.getByRole('heading', { name: 'Sales overview' })).toBeVisible();

  // Escape exits.
  await page.keyboard.press('Escape');
  await expect(view).toBeHidden();
});

test('command palette filters and runs "New SQL cell"', async ({ page }) => {
  const before = await page.getByTestId('notebook-cell').count();
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Type a command…');
  await input.fill('New SQL');
  // Only matching commands remain; activating the top one adds a cell.
  await expect(
    page.getByRole('dialog', { name: 'Command palette' }).getByText('New SQL cell'),
  ).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('notebook-cell')).toHaveCount(before + 1);
});

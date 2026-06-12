import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * Shared E2E helpers (design.md §9, P6). These wrap the operational patterns the
 * P3–P5 screenshot scripts established, but as test-grade utilities: every wait
 * is anchored to a network response or a DOM/state condition (no fixed
 * `waitForTimeout`), so the suites stay non-flaky on a real Trino.
 *
 * Conventions
 *  - Each test resets the workspace (theme, sidebar, drafts) so it is independent
 *    of run order and of any persisted developer state.
 *  - Multi-line SQL is pushed straight into the Monaco model through the dev-only
 *    `window.__fableEditors` hook — typing it is unreliable (auto-indent +
 *    suggest acceptance scramble it). Single keystrokes (Ctrl+Enter, etc.) still
 *    go through the real keyboard path.
 */

export const TINY = { catalog: 'tpch', schema: 'tiny' };

/** A unique-ish suffix so notebooks / saved queries created by a test don't collide. */
export function rnd(prefix = ''): string {
  return `${prefix}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Reset persisted browser state to a known baseline, then load the app. Clears
 * any draft notebooks / workspace snapshot exactly once (guarded by a sentinel),
 * sets the theme + sidebar, and seeds the recent context to tpch.tiny so new
 * notebooks default there.
 *
 * The clear is one-shot so a later `page.reload()` keeps the workspace snapshot
 * the app just persisted (so the save → reload → restore test works). The init
 * script runs on every navigation but only clears when the sentinel is absent.
 */
export async function resetWorkspace(
  page: Page,
  opts: { theme?: 'light' | 'dark'; sidebarTab?: string; context?: { catalog: string; schema: string } } = {},
): Promise<void> {
  const theme = opts.theme ?? 'light';
  const sidebarTab = opts.sidebarTab ?? 'data';
  const context = opts.context ?? TINY;
  await page.addInitScript(
    ({ theme, sidebarTab, context }) => {
      try {
        const SENTINEL = '__e2e_reset__';
        if (!window.localStorage.getItem(SENTINEL)) {
          window.localStorage.clear();
          window.localStorage.setItem(SENTINEL, '1');
          window.localStorage.setItem(
            'hubble-ui',
            JSON.stringify({
              state: { theme, sidebarTab, sidebarWidth: 320, sidebarCollapsed: false },
              version: 0,
            }),
          );
          window.localStorage.setItem('hubble-recent-contexts', JSON.stringify([context]));
        }
      } catch {
        /* ignore */
      }
      // The app's UI store applies `data-theme` from the persisted `hubble-ui`
      // entry on load, so we don't touch documentElement here (it may not exist
      // yet at document_start, and throwing would abort the init script).
    },
    { theme, sidebarTab, context },
  );
  await page.goto('/');
  await waitEditorReady(page);
}

/** Wait until at least one Monaco editor has mounted and registered its language. */
export async function waitEditorReady(page: Page, timeout = 30_000): Promise<void> {
  await page.locator('[data-testid="sql-editor"][data-ready="true"]').first().waitFor({ timeout });
}

/**
 * Set the nth *visible* SQL cell's full text via its Monaco model (and focus
 * it). We address the editor through the host DOM node (`[data-testid=
 * "sql-editor"]`.__fableEditor) so it stays correct across cell delete / reorder
 * — the global `__fableEditors` array is mount-order and goes stale.
 *
 * `setValue` fires Monaco's change event synchronously, which the cell forwards
 * to the notebook store; we then wait two animation frames so React commits the
 * resulting render (so subsequent assertions / clicks see the new source — e.g.
 * the delete-confirm threshold or the variable panel).
 */
export async function setEditor(page: Page, index: number, text: string): Promise<void> {
  await page.locator('[data-testid="sql-editor"]').nth(index).waitFor();
  await page.evaluate(
    async ({ index, value }) => {
      const hosts = document.querySelectorAll('[data-testid="sql-editor"]');
      const host = hosts[index] as (Element & { __fableEditor?: unknown }) | undefined;
      const editor = host?.__fableEditor as
        | {
            setValue: (v: string) => void;
            focus: () => void;
            getModel: () => { getLineCount: () => number; getLineMaxColumn: (n: number) => number } | null;
            setPosition: (p: { lineNumber: number; column: number }) => void;
          }
        | undefined;
      if (!editor) throw new Error(`no editor for visible cell #${index}`);
      editor.setValue(value);
      const model = editor.getModel();
      if (model) {
        const last = model.getLineCount();
        editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
      }
      editor.focus();
      // Let React flush the store-driven re-render before the test proceeds.
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    { index, value: text },
  );
}

/** Read the nth visible SQL cell's current Monaco value. */
export async function getEditorValue(page: Page, index = 0): Promise<string> {
  return page.evaluate((index) => {
    const hosts = document.querySelectorAll('[data-testid="sql-editor"]');
    const host = hosts[index] as (Element & { __fableEditor?: { getValue: () => string } }) | undefined;
    return host?.__fableEditor?.getValue() ?? '';
  }, index);
}

/** Place the caret of the nth visible SQL cell at an absolute line/column. */
export async function setCaret(
  page: Page,
  index: number,
  pos: { lineNumber: number; column: number },
): Promise<void> {
  await page.evaluate(
    ({ index, pos }) => {
      const hosts = document.querySelectorAll('[data-testid="sql-editor"]');
      const host = hosts[index] as (Element & { __fableEditor?: unknown }) | undefined;
      const editor = host?.__fableEditor as
        | { setPosition: (p: { lineNumber: number; column: number }) => void; focus: () => void }
        | undefined;
      if (!editor) throw new Error(`no editor for visible cell #${index}`);
      editor.setPosition(pos);
      editor.focus();
    },
    { index, pos },
  );
}

/** The nth notebook cell wrapper. */
export function cell(page: Page, index = 0): Locator {
  return page.getByTestId('notebook-cell').nth(index);
}

/** Open the command palette and wait for its input. */
export async function openPalette(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Type a command…');
  await expect(input).toBeVisible();
  return input;
}

/** Run a palette command by name (waits for the option, then activates it). */
export async function runPaletteCommand(page: Page, label: string): Promise<void> {
  const input = await openPalette(page);
  await input.fill(label);
  const option = page.getByRole('dialog', { name: 'Command palette' }).getByText(label, { exact: true });
  await expect(option.first()).toBeVisible();
  await option.first().click();
}

/**
 * Add a cell of the given kind via the command palette and wait until the cell
 * count grows. Returns the new total.
 */
export async function addCell(page: Page, kind: 'sql' | 'markdown'): Promise<number> {
  const before = await page.getByTestId('notebook-cell').count();
  await runPaletteCommand(page, kind === 'sql' ? 'New SQL cell' : 'New Markdown cell');
  await expect(page.getByTestId('notebook-cell')).toHaveCount(before + 1);
  return before + 1;
}

/** Run the focused editor via Ctrl+Enter. Assumes the editor already has focus. */
export async function runFocused(page: Page): Promise<void> {
  await page.keyboard.press('Control+Enter');
}

/**
 * Focus the SQL editor of cell #index and run it (Ctrl+Enter). Returns once the
 * keystroke is dispatched — callers await a concrete result/state afterwards.
 */
export async function runCell(page: Page, index = 0): Promise<void> {
  await cell(page, index).locator('[data-testid="sql-editor"]').click();
  await page.keyboard.press('Control+Enter');
}

/** Locator for a cell's result pane. */
export function resultPane(page: Page, index = 0): Locator {
  return cell(page, index).getByTestId('result-pane');
}

/** Wait for a cell's StateBadge to read FINISHED (terminal-success). */
export async function expectFinished(page: Page, index = 0): Promise<void> {
  await expect(cell(page, index).getByText('FINISHED', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Wait for the result grid + its "N rows · M columns" footer to settle. */
export async function waitGrid(page: Page, index = 0): Promise<void> {
  const pane = resultPane(page, index);
  await pane.getByRole('tab', { name: 'Grid' }).click();
  await pane.getByTestId('result-grid').waitFor({ timeout: 30_000 });
  await expect(pane.getByText(/\d[\d,]* rows · \d+ columns/).first()).toBeVisible({
    timeout: 30_000,
  });
}

/** Run cell #index and wait for the grid to be populated. */
export async function runCellToGrid(page: Page, index = 0): Promise<void> {
  await runCell(page, index);
  await expectFinished(page, index);
  await waitGrid(page, index);
}

/** Switch a cell's result pane to a named tab. */
export async function openResultTab(
  page: Page,
  tab: 'Grid' | 'Chart' | 'Explain' | 'Details',
  index = 0,
): Promise<void> {
  await resultPane(page, index).getByRole('tab', { name: tab }).click();
}

// ---- Server-side seeding (via the proxied API, deterministic) --------------

export interface SeedSavedQuery {
  name: string;
  description?: string;
  statement: string;
  catalog?: string;
  schema?: string;
  isFavorite?: boolean;
}

/** Create a saved query through the API; returns its id. */
export async function seedSavedQuery(
  request: APIRequestContext,
  q: SeedSavedQuery,
): Promise<string> {
  const res = await request.post('/api/saved-queries', { data: { catalog: 'tpch', schema: 'tiny', ...q } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id as string;
}

/** Run a statement to a terminal state through the API (so it lands in history). */
export async function runToHistory(
  request: APIRequestContext,
  statement: string,
  ctx = TINY,
): Promise<string> {
  const res = await request.post('/api/queries', {
    data: { statement, ...ctx, source: 'hubble' },
  });
  const { queryId } = await res.json();
  for (let i = 0; i < 120; i++) {
    const snap = await request.get(`/api/queries/${queryId}`).then((r) => r.json());
    if (['finished', 'failed', 'canceled'].includes(snap.state)) return snap.state;
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'timeout';
}

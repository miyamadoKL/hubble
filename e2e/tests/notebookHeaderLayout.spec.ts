import { test, expect, type Page } from '@playwright/test';
import { resetWorkspace } from './helpers';

/**
 * NotebookHeader のタイトル/説明を「表示 → 編集 → 表示」と往復させたときに、
 * 実ブラウザ上でヘッダー自身と直下、右隣の要素が動かないことを検証する。
 * jsdom はレイアウトを計算しないため、この不変条件は実ブラウザでしか検証できない。
 *
 * @param page - 対象ページ。
 * @returns タイトル本体、説明本体、直下の1セル目、右側の Share ボタンの
 *   getBoundingClientRect() をまとめたスナップショット。
 */
async function captureHeaderRects(page: Page) {
  return page.evaluate(() => {
    const rectOf = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, bottom: r.bottom };
    };
    const title = document.querySelector('h1, input[aria-label="Notebook name"]');
    const desc = document.querySelector(
      'p[title="Click to edit description"], input[aria-label="Notebook description"]',
    );
    const firstCell = document.querySelector('[data-testid="notebook-cell"]');
    const shareButton = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Share',
    );
    return {
      title: rectOf(title),
      desc: rectOf(desc),
      firstCell: rectOf(firstCell),
      shareButton: rectOf(shareButton ?? null),
    };
  });
}

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('clicking the description into edit mode does not move surrounding layout', async ({
  page,
}) => {
  const before = await captureHeaderRects(page);
  expect(before.desc).not.toBeNull();
  expect(before.firstCell).not.toBeNull();

  // 説明（プレースホルダー含む）をクリックして編集モードへ入る。
  await page.getByTitle('Click to edit description').click();
  const editInput = page.getByLabel('Notebook description');
  await expect(editInput).toBeVisible();
  await expect(editInput).toBeFocused();

  const editing = await captureHeaderRects(page);

  // blur で確定し、表示モードへ戻す。
  await editInput.blur();
  await expect(page.getByTitle('Click to edit description')).toBeVisible();
  const after = await captureHeaderRects(page);

  // 説明ボックス自身の高さと上端位置が表示⇔編集で変わらないこと。
  expect(editing.desc?.height).toBeCloseTo(before.desc!.height, 1);
  expect(editing.desc?.top).toBeCloseTo(before.desc!.top, 1);

  // 直下のセル(1セル目)の位置が表示⇔編集切り替えで動かないこと
  // (これが実際に報告されている「クリックのたびにガタつく」現象の直接の証拠になる)。
  expect(editing.firstCell?.top).toBeCloseTo(before.firstCell!.top, 1);
  expect(after.firstCell?.top).toBeCloseTo(before.firstCell!.top, 1);

  // ヘッダー右側の Share ボタンが横方向にも動かないこと。
  if (before.shareButton) {
    expect(editing.shareButton?.x).toBeCloseTo(before.shareButton.x, 1);
  }
});

test('clicking the title into edit mode does not move surrounding layout', async ({ page }) => {
  const before = await captureHeaderRects(page);
  expect(before.title).not.toBeNull();

  await page.locator('h1[title="Click to rename"]').click();
  const editInput = page.getByLabel('Notebook name');
  await expect(editInput).toBeVisible();

  const editing = await captureHeaderRects(page);

  await editInput.blur();
  const after = await captureHeaderRects(page);

  expect(editing.title?.height).toBeCloseTo(before.title!.height, 1);
  expect(editing.title?.top).toBeCloseTo(before.title!.top, 1);
  expect(editing.desc?.top).toBeCloseTo(before.desc!.top, 1);
  expect(editing.firstCell?.top).toBeCloseTo(before.firstCell!.top, 1);
  expect(after.firstCell?.top).toBeCloseTo(before.firstCell!.top, 1);
});

test('double-clicking a cell name into edit mode does not move the toolbar icons', async ({
  page,
}) => {
  // 注意: page 全体を `getByTitle('Double-click to rename')` で探すと、ノートブック
  // タブの title 属性 "...(double-click to rename)"（大小無視の部分一致）にも
  // マッチしてしまう。セル内に限定してボタンを取得する。
  const cellName = page
    .getByTestId('notebook-cell')
    .first()
    .getByRole('button', { name: 'Untitled cell' });
  await expect(cellName).toBeVisible();
  const before = await cellName.evaluate((el) => el.getBoundingClientRect());
  const runButton = page.getByRole('button', { name: 'Run cell' }).first();
  const runBefore = await runButton.evaluate((el) => el.getBoundingClientRect());

  await cellName.dblclick();
  const editInput = page.getByLabel('Cell name').first();
  await expect(editInput).toBeVisible();
  const editing = await editInput.evaluate((el) => el.getBoundingClientRect());
  const runEditing = await runButton.evaluate((el) => el.getBoundingClientRect());

  await editInput.blur();

  // セル名ボックス自身の高さと左端が表示⇔編集で変わらないこと。
  expect(editing.height).toBeCloseTo(before.height, 1);
  expect(editing.x).toBeCloseTo(before.x, 1);

  // 右側の実行ボタンなどツールバーアイコン群が横に動かないこと。
  expect(runEditing.x).toBeCloseTo(runBefore.x, 1);
});

test('a long cell name keeps the same box width between display and edit', async ({ page }) => {
  // 名前が短い「Untitled cell」では表示側 <button> と編集側 <input> の幅がたまたま
  // 近い値になり得るため、幅のずれは長い名前でしか顕在化しない。実測(Chromium):
  // 固定幅を持たない表示側は内容幅ぶん伸びて 331px、編集側は w-40 で 160px 固定だった。
  const cellName = page
    .getByTestId('notebook-cell')
    .first()
    .getByRole('button', { name: 'Untitled cell' });
  await cellName.dblclick();
  const editInput = page.getByLabel('Cell name').first();
  await editInput.fill('A Really Quite Long Cell Name For Testing Overflow Behavior');
  await editInput.press('Enter');

  const longNameButton = page
    .getByTestId('notebook-cell')
    .first()
    .getByRole('button', { name: /A Really Quite Long/ });
  const displayWidth = await longNameButton.evaluate((el) => el.getBoundingClientRect().width);

  await longNameButton.dblclick();
  const editInput2 = page.getByLabel('Cell name').first();
  await expect(editInput2).toBeVisible();
  const editWidth = await editInput2.evaluate((el) => el.getBoundingClientRect().width);

  expect(editWidth).toBeCloseTo(displayWidth, 1);
});

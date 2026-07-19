import { test, expect, type Page } from '@playwright/test';
import { resetWorkspace, setEditor, runCellToGrid, cell } from './helpers';

/**
 * i18n 第 2a フェーズ（Notebook 領域）の実ブラウザ検証。
 *
 * jsdom ベースの単体テスト（`i18nNotebookAccessibleName.test.tsx`）では翻訳キーが
 * 正しいロケールの文字列に切り替わることまでは検証できるが、実際にレイアウトが
 * 崩れていないか（日英で文字数が大きく変わるラベルによる overflow）は計算された
 * レイアウトを持つ実ブラウザでしか確認できない。このスイートはノートブックのセル、
 * ツールバー、結果グリッド、Save query モーダルを日本語/英語の両ロケールで開き、
 * (a) 主要要素が横方向に overflow していないこと、(b) ロケール切替で実際にラベルが
 * 翻訳されることを確認する。`i18nScheduleAlertLayout.spec.ts`（Phase 1）を前例とする。
 */

/**
 * `container` 配下の全要素の overflowPx を、DOM 構造上の位置（ルートからの子要素
 * インデックス連結）をキーにして返す。`i18nScheduleAlertLayout.spec.ts` の同名関数と
 * 同じ実装（helpers.ts には汎用の overflow 計測ヘルパーが無いため、このファイルにも
 * 複製する）。
 */
async function measureOverflowByPath(
  page: Page,
  containerSelector: string,
): Promise<Record<string, { tag: string; overflowPx: number }>> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return {};

    // Tooltip 本体は常時 DOM 上に存在し opacity:0 で配置されるため、非表示時でも
    // scrollWidth に算入されて偽陽性を招く。計測前に一時的に display:none にする。
    const tooltips = Array.from(root.querySelectorAll<HTMLElement>('[role="tooltip"]'));
    const savedDisplay = tooltips.map((el) => el.style.display);
    tooltips.forEach((el) => {
      el.style.display = 'none';
    });

    const result: Record<string, { tag: string; overflowPx: number }> = {};
    try {
      const walk = (el: Element, path: string) => {
        result[path] = {
          tag: el.tagName.toLowerCase(),
          overflowPx: el.scrollWidth - el.clientWidth,
        };
        Array.from(el.children).forEach((child, i) => walk(child, `${path}.${i}`));
      };
      walk(root, '0');
    } finally {
      tooltips.forEach((el, i) => {
        el.style.display = savedDisplay[i] ?? '';
      });
    }
    return result;
  }, containerSelector);
}

/**
 * `container` 配下で水平方向に overflow している要素（scrollWidth が clientWidth を
 * 一定以上超えるもの）を探す。`measureOverflowByPath` と同じ理由で tooltip を除外する。
 */
async function findHorizontalOverflow(
  page: Page,
  containerSelector: string,
): Promise<{ tag: string; text: string; overflowPx: number }[]> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return [];

    const tooltips = Array.from(root.querySelectorAll<HTMLElement>('[role="tooltip"]'));
    const savedDisplay = tooltips.map((el) => el.style.display);
    tooltips.forEach((el) => {
      el.style.display = 'none';
    });

    const offenders: { tag: string; text: string; overflowPx: number }[] = [];
    try {
      const walk = (el: Element) => {
        const overflowPx = el.scrollWidth - el.clientWidth;
        if (overflowPx > 2) {
          offenders.push({
            tag: el.tagName.toLowerCase(),
            text: (el.textContent ?? '').trim().slice(0, 60),
            overflowPx,
          });
        }
        for (const child of Array.from(el.children)) walk(child);
      };
      walk(root);
    } finally {
      tooltips.forEach((el, i) => {
        el.style.display = savedDisplay[i] ?? '';
      });
    }
    return offenders;
  }, containerSelector);
}

/**
 * 英語版を基準に、日本語版で「同じ構造上の位置にある要素」ごとに overflow が
 * 悪化していないかを検証する（要素ごとの対応比較。`i18nScheduleAlertLayout.spec.ts`
 * と同じ理由で、最大値同士の比較ではなく要素ごとの対応比較を使う）。
 */
function expectNoOverflowRegression(
  label: string,
  en: Record<string, { tag: string; overflowPx: number }>,
  ja: Record<string, { tag: string; overflowPx: number }>,
): void {
  const regressions: { path: string; tag: string; enPx: number; jaPx: number }[] = [];
  for (const [path, jaEntry] of Object.entries(ja)) {
    const enPx = en[path]?.overflowPx ?? 0;
    if (jaEntry.overflowPx > enPx + 2) {
      regressions.push({ path, tag: jaEntry.tag, enPx, jaPx: jaEntry.overflowPx });
    }
  }
  expect(regressions, `${label}: ${JSON.stringify(regressions)}`).toEqual([]);
}

/**
 * LocaleToggle をクリックして言語を切り替える。`data-testid="locale-toggle"` で
 * ロケールに依存せず特定する（`i18nScheduleAlertLayout.spec.ts` と同じ理由）。
 */
async function switchToJapanese(page: Page): Promise<void> {
  await page.getByTestId('locale-toggle').click();
}

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('セルツールバーと結果ペインのタブバー: 英語(既定)→日本語切替でラベルが翻訳され、どちらでも overflow しない', async ({
  page,
}) => {
  // セルを実行して StatsStrip / ResultPane / ResultGrid まで実データで描画させる。
  // 計測対象は CellToolbar と ResultPane のタブバー（result-pane-toolbar）のみに絞る:
  // Monaco エディタ本体と結果グリッドの行データは意図的に横スクロールする設計
  // （長い SQL / 長い文字列セル）なので、そこを含めて overflow ゼロを要求すると
  // i18n と無関係な既存の特性を誤って regression として検出してしまう。
  await setEditor(page, 0, 'SELECT * FROM tpch.tiny.nation');
  await runCellToGrid(page, 0);

  const notebookCell = cell(page, 0);
  const toolbarSelector = '[data-testid="notebook-cell"] [data-testid="cell-toolbar"]';
  const resultTabsSelector = '[data-testid="notebook-cell"] [data-testid="result-pane-toolbar"]';

  // ---- 英語（既定）のベースラインを取る ----
  await expect(notebookCell.getByRole('button', { name: 'Collapse cell' })).toBeVisible();
  const toolbarEn = await measureOverflowByPath(page, toolbarSelector);
  const resultTabsEn = await measureOverflowByPath(page, resultTabsSelector);
  const offendersEn = [
    ...(await findHorizontalOverflow(page, toolbarSelector)),
    ...(await findHorizontalOverflow(page, resultTabsSelector)),
  ];
  expect(offendersEn, JSON.stringify(offendersEn)).toEqual([]);

  // ---- 日本語へ切替し、同じセルで再計測する ----
  await switchToJapanese(page);
  await expect(notebookCell.getByRole('button', { name: 'セルを折りたたむ' })).toBeVisible();
  // 結果グリッドの読み込み済み件数表示（「N 件読み込み済み」）が翻訳されていることを確認する。
  await expect(notebookCell.getByText(/\d+ 件読み込み済み/)).toBeVisible();

  const toolbarJa = await measureOverflowByPath(page, toolbarSelector);
  const resultTabsJa = await measureOverflowByPath(page, resultTabsSelector);
  const offendersJa = [
    ...(await findHorizontalOverflow(page, toolbarSelector)),
    ...(await findHorizontalOverflow(page, resultTabsSelector)),
  ];
  expect(offendersJa, JSON.stringify(offendersJa)).toEqual([]);

  expectNoOverflowRegression('CellToolbar', toolbarEn, toolbarJa);
  expectNoOverflowRegression('ResultPane タブバー', resultTabsEn, resultTabsJa);
});

test('Save query モーダル: 英語(既定)→日本語切替でラベルが翻訳され、どちらでも overflow しない', async ({
  page,
}) => {
  await setEditor(page, 0, 'SELECT 1 AS answer');

  const dialog = page.getByRole('dialog');
  const openButton = cell(page, 0).getByRole('button', { name: 'Save query' });

  await openButton.click();
  await expect(dialog).toBeVisible();
  // 既定（英語）では従来どおり "Save query" / "Name"。
  await expect(dialog.getByText('Save query', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText('Name', { exact: true })).toBeVisible();

  const offendersEn = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersEn, JSON.stringify(offendersEn)).toEqual([]);

  // ロケール切替は背後の TopBar にあり、開いたままだとバックドロップにクリックが
  // 遮られるため、いったん閉じてから切り替える。
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await switchToJapanese(page);

  await cell(page, 0).getByRole('button', { name: 'クエリを保存' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('クエリを保存', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText('名前', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Save query', { exact: true })).toHaveCount(0);

  const offendersJa = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersJa, JSON.stringify(offendersJa)).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('チャートタブと Column stats パネル: 日本語ロケールでラベルが翻訳され overflow しない', async ({
  page,
}) => {
  // runCellToGrid (helpers.ts) はタブ名 "Grid" を前提にしているため、まず英語
  // （既定ロケール）のままセルを実行してグリッドを描画させ、その後で日本語へ
  // 切り替える（helpers.ts は原則変更しない方針のため、ここでは呼び出し順で対応する）。
  await setEditor(page, 0, 'SELECT nationkey, name FROM tpch.tiny.nation');
  await runCellToGrid(page, 0);
  await switchToJapanese(page);

  const pane = cell(page, 0).getByTestId('result-pane');

  // Chart タブ（日本語ラベル「チャート」）に切り替え、ChartControls のラベルが
  // 翻訳されていることを確認する。
  await pane.getByRole('tab', { name: 'チャート' }).click();
  await expect(pane.getByTestId('chart-controls')).toBeVisible();
  await expect(pane.getByText('X 軸', { exact: true })).toBeVisible();

  const chartOffenders = await findHorizontalOverflow(page, '[data-testid="result-pane"]');
  expect(chartOffenders, JSON.stringify(chartOffenders)).toEqual([]);

  // Grid タブへ戻り、Column stats パネルを開く。
  await pane.getByRole('tab', { name: 'グリッド' }).click();
  await pane.getByRole('button', { name: '列の統計' }).click();
  await expect(page.getByTestId('column-profile-panel')).toBeVisible();
  await expect(
    page.getByTestId('column-profile-panel').getByText(/行をプロファイル済み/),
  ).toBeVisible();

  const profileOffenders = await findHorizontalOverflow(
    page,
    '[data-testid="column-profile-panel"]',
  );
  expect(profileOffenders, JSON.stringify(profileOffenders)).toEqual([]);
});

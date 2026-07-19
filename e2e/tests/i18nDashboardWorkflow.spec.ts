import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { resetWorkspace, rnd } from './helpers';

/**
 * i18n 第 2d フェーズ（Dashboard / Workflow / データブラウザ / GitHub / AI パネル）の
 * 実ブラウザ検証。
 *
 * jsdom ベースの単体テスト（コンポーネント別の `i18n*AccessibleName.test.tsx`）では、
 * 翻訳キーが正しいロケールの文字列に切り替わることまでは検証できるが、実際にレイアウトが
 * 崩れていないか（日英で文字数が大きく変わるラベルによる overflow）は計算されたレイアウトを
 * 持つ実ブラウザでしか確認できない。このスイートは Phase 1 の
 * `i18nScheduleAlertLayout.spec.ts` を前例とし、Dashboard 一覧とウィジェット追加モーダル、
 * Workflow ビュー、SchemaTree（データブラウザ）を日本語/英語の両ロケールで検査する。
 */

/**
 * `container` 配下の要素を、DOM 構造上の位置（ルートからの子要素インデックス連結。
 * 例 "0.2.1"）をキーにした overflow マップへ変換する。英語版と日本語版で DOM の形
 * （要素の数と入れ子構造）はテキスト以外変わらないため、このキーで「同じ要素」を
 * ロケールをまたいで対応付けられる。`[role="tooltip"]` は常時 DOM 上に存在し
 * `opacity: 0` で配置されるため（`Tooltip.tsx`）、非表示時でも scrollWidth に
 * 算入されて偽陽性を招く。計測前に一時的に `display: none` にしてから測り、
 * 測定後に元へ戻す（`i18nScheduleAlertLayout.spec.ts` と同じ手法）。
 */
async function measureOverflowByPath(
  page: Page,
  containerSelector: string,
): Promise<Record<string, { tag: string; overflowPx: number }>> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return {};

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
 * 英語版を基準に、日本語版で「同じ構造上の位置にある要素」ごとに overflow が
 * 悪化していないかを検証する。全要素の最大値同士を比較する方式だと、英語版で
 * 既に overflow している i18n と無関係な既存要素が基準値を底上げしてしまい、
 * 日本語版でだけ新たに悪化する別要素の regression を見逃す
 * （`i18nScheduleAlertLayout.spec.ts` のレビュー指摘と同じ理由）。
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
 * LocaleToggle をクリックして言語を切り替える。ボタンの可視テキストは現在ロケール
 * （"EN"/"JA"）そのもので、切替先を表す aria-label とは異なるため、ロケールに
 * 依存しない `data-testid="locale-toggle"` で特定する。
 */
async function switchToJapanese(page: Page): Promise<void> {
  await page.getByTestId('locale-toggle').click();
}

/**
 * ワークフローを API 経由で作成し、その id を返す。cron は付けず手動実行のみの
 * 最小構成にする（i18n レイアウト検証で WorkflowsPanel/WorkflowView に実データを
 * 表示させるためだけに使うヘルパーで、`helpers.ts` の既存 seed 関数群との衝突を
 * 避けるため接頭辞 `i18n` を付けてこのファイル内に閉じている）。
 */
async function i18nSeedWorkflow(
  request: APIRequestContext,
  q: { name: string; statement: string },
): Promise<string> {
  const res = await request.post('/api/workflows', {
    headers: { 'Sec-Fetch-Site': 'same-origin' },
    data: {
      name: q.name,
      stages: [{ steps: [{ id: 'step-1', name: 'Step 1', statement: q.statement }] }],
    },
  });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id as string;
}

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('Dashboard 一覧とウィジェット追加モーダル: 英語(既定)→日本語切替でラベルが翻訳され、どちらでも overflow しない', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Dashboards', exact: true }).click();

  const newDashboardButton = page.getByRole('button', {
    name: /^(New dashboard|新規ダッシュボード)$/,
  });
  await expect(newDashboardButton).toBeVisible();

  // ---- 英語（既定）: 新規ダッシュボードを開き、ウィジェット追加モーダルを検証する ----
  await newDashboardButton.click();
  const addWidgetButton = page.getByRole('button', { name: /^(Add widget|ウィジェットを追加)$/ });
  await expect(addWidgetButton).toBeVisible();

  await addWidgetButton.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Add widget', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Type', { exact: true })).toBeVisible();

  // text widget を選び、overflow せずにモーダルを操作できることを確認する。
  await dialog.getByRole('button', { name: 'Text', exact: true }).click();
  await dialog.locator('textarea').fill('# i18n dashboard widget');

  const offendersModalEn = await measureOverflowByPath(page, '[role="dialog"]');

  await dialog.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(dialog).toBeHidden();

  const mainEn = await measureOverflowByPath(page, 'main');

  // ---- 日本語へ切替。ロケールトグルは TopBar 側にあるためモーダルは既に閉じている前提。 ----
  await switchToJapanese(page);

  await expect(page.getByText('ウィジェットがありません')).toHaveCount(0); // widget を1つ追加済みなので空状態は出ない
  await expect(addWidgetButton).toBeVisible();
  await addWidgetButton.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('ウィジェットを追加', { exact: true })).toBeVisible();
  await expect(dialog.getByText('種別', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Add widget', { exact: true })).toHaveCount(0);

  await dialog.getByRole('button', { name: 'テキスト', exact: true }).click();
  await dialog.locator('textarea').fill('# i18n dashboard widget ja');

  const offendersModalJa = await measureOverflowByPath(page, '[role="dialog"]');

  // レビュー指摘: ここで「追加」を押すと英語パスの widget に加えてもう1枚
  // widget が増え、mainEn (widget 1枚) と mainJa (widget 2枚) で DOM 構造が
  // 異なる状態を比較してしまい、要素対応比較 (measureOverflowByPath) が
  // 意味を持たなくなる。ウィジェット数と編集状態を英語パスと揃えるため、
  // ここでは追加せず「キャンセル」で閉じる（モーダル自体の翻訳や overflow は
  // 既に offendersModalJa で検証済み）。
  await dialog.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(dialog).toBeHidden();

  const mainJa = await measureOverflowByPath(page, 'main');

  expectNoOverflowRegression('AddWidgetModal', offendersModalEn, offendersModalJa);
  expectNoOverflowRegression('DashboardView (main)', mainEn, mainJa);
});

test('Dashboard 一覧の空状態と widget 件数表示が日本語化で overflow を悪化させない', async ({
  page,
}) => {
  // 'Dashboards' タブは初回のみ開く。ロケール切替はサイドバーのタブ選択状態を
  // 変えないため、切替後に同じタブボタンを再クリックすると「既にアクティブな
  // タブの再クリック = 折りたたみ」という Sidebar の仕様（Sidebar.tsx の
  // `if (effectiveTab === item.id && !collapsed) toggleSidebar()`）に触れて
  // パネルごと DOM から外れてしまう（測定対象が消え、regression を検出できない
  // 偽陰性テストになる）。そのため以降のテストでも、ロケール切替の前後で
  // 同じタブを 2 回クリックすることはしない。
  await page.getByRole('button', { name: 'Dashboards', exact: true }).click();
  const sidebarEn = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');

  await switchToJapanese(page);
  const sidebarJa = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');

  expectNoOverflowRegression('DashboardsPanel (empty/list state)', sidebarEn, sidebarJa);
});

test('Workflow ビュー: 一覧行の状態表示とヘッダー操作が日本語化で翻訳され、overflow を悪化させない', async ({
  page,
  request,
}) => {
  const workflowName = `i18n layout workflow ${rnd()}`;
  await i18nSeedWorkflow(request, {
    name: workflowName,
    statement: 'SELECT count(*) FROM tpch.tiny.nation',
  });

  // ---- 英語（既定）のベースライン ----
  // 他の実行（並列 e2e バッチや前回実行の残留データ）が作った "never run" な
  // ワークフローが一覧に紛れている可能性があるため、この行だけに絞って検証する。
  await page.getByRole('button', { name: 'Workflows', exact: true }).click();
  const row = page.getByRole('button', { name: new RegExp(`^${workflowName}\\b`) });
  await expect(row).toBeVisible({ timeout: 10_000 });
  // cron 未設定、実行履歴なしの最小構成なので "never run" / "manual only" が出る。
  await expect(row.getByText('never run', { exact: true })).toBeVisible();
  await expect(row.getByText('manual only', { exact: true })).toBeVisible();

  const sidebarEn = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');

  const main = page.locator('main');
  await page.getByText(workflowName).click();
  // TopBar（banner）側にも汎用の "Save" ボタン（アクティブなノートブックの保存）が
  // 常時存在するため、`main` 配下に絞って WorkflowView 自身の Save ボタンを特定する。
  await expect(main.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Add stage', exact: true })).toBeVisible();
  const mainEn = await measureOverflowByPath(page, 'main');

  // ---- 日本語へ切替。サイドバーのタブ選択と main の開いているドキュメントは
  // どちらもロケール状態と独立しており、切替だけで両方とも翻訳済み文言に
  // 再レンダリングされる（タブやドキュメントの再選択は不要）。 ----
  await switchToJapanese(page);

  await expect(row.getByText('未実行', { exact: true })).toBeVisible();
  await expect(row.getByText('手動のみ', { exact: true })).toBeVisible();
  await expect(row.getByText('never run', { exact: true })).toHaveCount(0);
  const sidebarJa = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');

  await expect(main.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  await expect(main.getByRole('button', { name: 'ステージを追加', exact: true })).toBeVisible();
  const mainJa = await measureOverflowByPath(page, 'main');

  expectNoOverflowRegression('WorkflowsPanel (sidebar)', sidebarEn, sidebarJa);
  expectNoOverflowRegression('WorkflowView (main)', mainEn, mainJa);
});

test('データブラウザ (SchemaTree/TableDetailPopover): テーブル詳細の見出しが日本語化され、狭幅パネルで overflow しない', async ({
  page,
}) => {
  // 'data' は `resetWorkspace` の既定サイドバータブなので、既に開いている状態。
  // 既にアクティブなタブを再クリックすると Sidebar が折りたたみ動作をしてしまう
  // ため（Sidebar.tsx 参照）、ここではタブボタンをクリックしない。

  // tpch → tiny → orders と展開し、テーブル詳細ポップオーバーを開く。
  await page.getByRole('button', { name: /^tpch/ }).first().click();
  await page.getByRole('button', { name: /^tiny/ }).first().click();
  await page
    .getByRole('button', { name: /^orders/ })
    .first()
    .hover();
  await page.getByRole('button', { name: 'Details for orders' }).first().click();

  const dialog = page.getByRole('dialog', { name: /orders/ });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Columns', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Sample · 10 rows')).toBeVisible({ timeout: 20_000 });
  // 「Sample · 10 rows」の見出しはセクションタイトル（静的翻訳文字列）であり、
  // サンプル行データの取得完了を意味しない。サンプルテーブル本体は別クエリの
  // 完了後に描画されるため、見出しの可視性だけを待つと計測タイミングが
  // 日英で揃わず（言語差ではなく単なるロード進捗差で）overflow 計測値が
  // ぶれる。実際の行が描画されるまで明示的に待ってから計測する。
  await expect(dialog.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });

  const dialogEn = await measureOverflowByPath(page, '[role="dialog"]');
  const sidebarEn = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  // ---- 日本語へ切替し、同じ操作を再度行う（タブは既にアクティブなので再クリックしない） ----
  await switchToJapanese(page);

  await page
    .getByRole('button', { name: /^orders/ })
    .first()
    .hover();
  await page.getByRole('button', { name: 'orders の詳細' }).first().click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('カラム', { exact: true })).toBeVisible();
  await expect(dialog.getByText('サンプル（10 行）')).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByText('Columns', { exact: true })).toHaveCount(0);
  await expect(dialog.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });

  const dialogJa = await measureOverflowByPath(page, '[role="dialog"]');
  const sidebarJa = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();

  expectNoOverflowRegression('TableDetailPopover', dialogEn, dialogJa);
  // データブラウザは狭幅サイドバーでの表示が既知の懸念点（タスク仕様に明記）なので、
  // ツリー行自体も要素対応比較で悪化していないか確認する。
  expectNoOverflowRegression('SchemaTree (narrow sidebar)', sidebarEn, sidebarJa);
});

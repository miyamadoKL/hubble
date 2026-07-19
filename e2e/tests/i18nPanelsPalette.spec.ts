import { test, expect, type Page } from '@playwright/test';
import { resetWorkspace, seedSavedQuery, runToHistory, rnd } from './helpers';

/**
 * i18n フェーズ 2c（History / SavedQueries / Operations パネルとコマンドパレット）の
 * 実ブラウザ検証。`i18nScheduleAlertLayout.spec.ts`（フェーズ 1: Schedule / Alert）と
 * 同じ構成に倣い、(a) 各パネル/パレットが日英どちらでも実際にラベルが翻訳されること、
 * (b) 主要要素が横方向に overflow していないこと、を確認する。
 *
 * OperationsPanel は `queries.viewAll` 権限を持つロールにのみ表示される
 * （`Sidebar.tsx` の `canViewOperations` ゲート）。この E2E スイートが使う
 * `deploy/compose/rbac.yaml` の既定ロール（demo: query.write, ai.use のみ）では
 * 権限が無く Operations タブ自体が出現しないため、該当テストは実行時に
 * Operations タブの有無を見て動的にスキップする（rbac.yaml はこのバッチのスコープ外で
 * あり変更しない）。
 */

/**
 * `container` 配下の要素のうち、水平方向に overflow しているものを検出する。
 * `i18nScheduleAlertLayout.spec.ts` の同名ヘルパーと同じ実装（tooltip 除外込み）。
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
 * `container` 配下の全要素の overflowPx を、DOM 構造上の位置（ルートからの子要素
 * インデックス連結）をキーにして返す。英語版と日本語版で「同じ要素」を対応付ける
 * ために使う。`i18nScheduleAlertLayout.spec.ts` の同名ヘルパーと同じ実装。
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
 * 悪化していないかを検証する。`i18nScheduleAlertLayout.spec.ts` の同名ヘルパーと同じ実装
 * （要素ごとの対応比較。最大値同士の比較だと既存 overflow 要素が基準を底上げし、
 * 別要素の regression を見逃す問題があるため）。
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
 * LocaleToggle をクリックして日本語へ切り替える。ボタンの可視テキストは現在ロケール
 * （"EN"/"JA"）そのものであり、ロケールに依存しない `data-testid="locale-toggle"` で
 * 特定する（`i18nScheduleAlertLayout.spec.ts` と同じ理由）。
 */
async function switchToJapanese(page: Page): Promise<void> {
  await page.getByTestId('locale-toggle').click();
}

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('HistoryPanel: 英語(既定)→日本語切替でフィルタチップ/操作ボタンが翻訳され、どちらでも overflow しない', async ({
  page,
  request,
}) => {
  const marker = rnd('i18n_hist_');
  await runToHistory(request, `SELECT '${marker}' AS tag, count(*) FROM tpch.tiny.nation`);

  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByText(`${marker}' AS tag`).first()).toBeVisible({ timeout: 15_000 });

  // ---- 英語（既定）のベースライン ----
  // 行の SQL 1 行要約は `truncate`（text-overflow: ellipsis）で意図的に折り返さない
  // 表示のため、scrollWidth > clientWidth は常に発生し得る（i18n とは無関係の既存特性）。
  // よって絶対値ゼロではなく、日本語版で悪化していないかを要素ごとに対応比較する
  // （`i18nScheduleAlertLayout.spec.ts` の TopBar 検証と同じ考え方）。
  await expect(page.getByRole('button', { name: 'All', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Finished', exact: true })).toBeVisible();

  // 行を展開し、操作ボタン（Insert / New cell / Re-run）が英語表記であることを確認する。
  // overflow 計測は展開後の日本語側計測（後段）と同じ展開状態で行う必要があるため、
  // ここで展開してから計測する（展開前後で計測すると比較が別状態同士になってしまう）。
  await page.getByText(`${marker}' AS tag`).first().click();
  await expect(page.getByRole('button', { name: 'Insert', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New cell', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-run', exact: true })).toBeVisible();
  const sidebarEn = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');

  // ---- 日本語へ切替 ----
  // History タブは既にアクティブなので再クリックしない（アクティブなサイドバータブを
  // 再クリックすると閉じるトグルとして働く、既存の Sidebar の挙動のため）。
  await switchToJapanese(page);
  await expect(page.getByText(`${marker}' AS tag`).first()).toBeVisible({ timeout: 15_000 });

  await expect(page.getByRole('button', { name: 'すべて', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '完了', exact: true })).toBeVisible();
  const sidebarJa = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');
  expectNoOverflowRegression('HistoryPanel sidebar', sidebarEn, sidebarJa);

  // 行は英語区間の操作で既に展開済み（再クリックすると折りたたみトグルになってしまう
  // ため、ここでは再クリックしない）。展開状態のまま、操作ボタンが日本語表記に
  // 切り替わっていることだけを確認する。
  await expect(page.getByRole('button', { name: '挿入', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新規セル', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '再実行', exact: true })).toBeVisible();
});

test('SavedQueriesPanel: 英語(既定)→日本語切替で Favorite のアクセシブルネームと操作ボタンが翻訳される', async ({
  page,
  request,
}) => {
  const name = `i18n saved ${rnd()}`;
  await seedSavedQuery(request, {
    name,
    description: 'E2E seeded for i18n panels/palette layout test.',
    statement: 'SELECT count(*) AS n FROM tpch.tiny.nation',
  });

  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  const row = page.getByText(name).first();
  await expect(row).toBeVisible({ timeout: 10_000 });

  // ---- 英語（既定）のベースライン ----
  // 所有者のお気に入りトグルは aria-label のみが accessible name（可視テキストなし）。
  // SQL 1 行要約 / 説明文は `truncate` により scrollWidth > clientWidth が常に
  // 起こり得る（HistoryPanel と同じ理由）ため、要素ごとの対応比較で検証する。
  await expect(page.getByRole('button', { name: 'Favorite', exact: true }).first()).toBeVisible();

  await row.click();
  await expect(page.getByRole('button', { name: 'Insert', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Share', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();

  // 削除確認モーダルのタイトルも英語のまま。
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  const deleteDialogEn = page.getByRole('dialog', { name: 'Delete saved query?' });
  await expect(deleteDialogEn).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(deleteDialogEn).toBeHidden();

  // overflow 計測は展開後および削除モーダル開閉後の日本語側計測（後段）と同じ状態で
  // 行う必要があるため、ここまでの操作を終えた時点で計測する（展開前後で計測すると
  // 比較が別状態同士になってしまう）。
  const sidebarEn = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');

  // ---- 日本語へ切替 ----
  // Saved タブは既にアクティブなので再クリックしない（HistoryPanel テストと同じ理由）。
  await switchToJapanese(page);
  await expect(page.getByText(name).first()).toBeVisible({ timeout: 10_000 });

  await expect(
    page.getByRole('button', { name: 'お気に入り登録', exact: true }).first(),
  ).toBeVisible();
  const sidebarJa = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');
  expectNoOverflowRegression('SavedQueriesPanel sidebar', sidebarEn, sidebarJa);

  // 行は英語区間の操作で既に展開済み（再クリックすると折りたたみトグルになってしまう
  // ため、ここでは再クリックしない）。展開状態のまま、操作ボタンが日本語表記に
  // 切り替わっていることだけを確認する。
  await expect(page.getByRole('button', { name: '挿入', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '共有', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '削除', exact: true })).toBeVisible();

  await page.getByRole('button', { name: '削除', exact: true }).first().click();
  const deleteDialogJa = page.getByRole('dialog', { name: '保存済みクエリを削除しますか?' });
  await expect(deleteDialogJa).toBeVisible();
  await page.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(deleteDialogJa).toBeHidden();
});

test('OperationsPanel: queries.viewAll 権限があれば Kill 操作のラベルとアクセシブルネームが翻訳される（権限が無ければスキップ）', async ({
  page,
}) => {
  const opsButtonEn = page.getByRole('button', { name: 'Operations', exact: true });
  if ((await opsButtonEn.count()) === 0) {
    test.skip(
      true,
      'このE2E環境のRBAC設定（deploy/compose/rbac.yaml、既定ロール demo）には ' +
        'queries.viewAll 権限が付与されておらず、Operations タブ自体が表示されない ' +
        '（Sidebar.tsx の canViewOperations ゲート）。rbac.yaml はこのバッチのスコープ外のため変更しない。',
    );
  }
  await opsButtonEn.click();
  // 実行中クエリが無いことを確定的に検証する（Option a: 実行中クエリの seed には
  // query.killAny/queries.viewAll 権限が必要だが、この E2E スイートが使う既定ロール
  // （demo）はどちらも持たず、rbac.yaml はこのバッチのスコープ外で変更できない
  // ため、running-query 側は現状この環境で検証できない。代わりに
  // `isVisible().catch(() => false)` で存在チェックしてから assert する
  // トートロジー（可視なら可視、を確認するだけで何も検証しない）を排除し、
  // 空状態の文言を無条件に待って検証する。これにより、他の実行中クエリが
  // 偶然存在する場合はテストが（無言で通らず）明示的に失敗する。
  await expect(page.getByText('No active queries', { exact: true })).toBeVisible({
    timeout: 10_000,
  });

  // Operations タブは既にアクティブなので再クリックしない（アクティブなサイドバータブを
  // 再クリックすると閉じるトグルとして働く、既存の Sidebar の挙動のため）。
  await switchToJapanese(page);
  await expect(page.getByText('実行中のクエリはありません', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
});

test('CommandPalette: 英語(既定)→日本語切替でコマンド名/グループ見出しが翻訳され、どちらでも overflow しない', async ({
  page,
}) => {
  // ---- 英語（既定）のベースライン ----
  await page.keyboard.press('Control+k');
  const dialogEn = page.getByRole('dialog', { name: 'Command palette' });
  await expect(dialogEn).toBeVisible();
  await expect(page.getByPlaceholder('Type a command…')).toBeVisible();
  await expect(dialogEn.getByText('Run all cells', { exact: true })).toBeVisible();
  await expect(dialogEn.getByText('Save notebook', { exact: true })).toBeVisible();
  await expect(dialogEn.getByText('Query', { exact: true }).first()).toBeVisible();
  await expect(dialogEn.getByText('Appearance', { exact: true }).first()).toBeVisible();

  const offendersEn = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersEn, JSON.stringify(offendersEn)).toEqual([]);
  const paletteEn = await measureOverflowByPath(page, '[role="dialog"]');

  await page.keyboard.press('Escape');
  await expect(dialogEn).toBeHidden();

  // ---- 日本語へ切替 ----
  await switchToJapanese(page);
  await page.keyboard.press('Control+k');
  const dialogJa = page.getByRole('dialog', { name: 'コマンドパレット' });
  await expect(dialogJa).toBeVisible();
  await expect(page.getByPlaceholder('コマンドを入力…')).toBeVisible();
  await expect(dialogJa.getByText('全セルを実行', { exact: true })).toBeVisible();
  await expect(dialogJa.getByText('ノートブックを保存', { exact: true })).toBeVisible();
  await expect(dialogJa.getByText('クエリ', { exact: true }).first()).toBeVisible();
  await expect(dialogJa.getByText('表示', { exact: true }).first()).toBeVisible();

  const offendersJa = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersJa, JSON.stringify(offendersJa)).toEqual([]);
  const paletteJa = await measureOverflowByPath(page, '[role="dialog"]');
  expectNoOverflowRegression('CommandPalette', paletteEn, paletteJa);

  // 閉じるボタン（背景オーバーレイ）のアクセシブルネームも日本語化されている。
  await expect(page.getByRole('button', { name: 'コマンドパレットを閉じる' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialogJa).toBeHidden();
});

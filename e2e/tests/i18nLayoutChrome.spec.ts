import { test, expect, type Page } from '@playwright/test';
import { resetWorkspace, seedSavedQuery, setEditor, rnd } from './helpers';

/**
 * i18n 第 2b フェーズ（レイアウト/共通コンポーネント/認証画面）の実ブラウザ検証。
 *
 * `i18nScheduleAlertLayout.spec.ts`（Phase 1）を前例として、Schedule/Alert 以外の
 * シェル領域（TopBar、Sidebar の各パネル、ContextSelector、ShareModal、
 * ShortcutsHelp）を日本語/英語の両ロケールで操作し、(a) 文言が実際に翻訳される
 * こと、(b) 日本語化で横方向 overflow が悪化しないことを検証する。
 *
 * AuthGate/AuthRequired は既定の e2e スイートが authMode=none で動くため UI からは
 * 到達できず、このスイートではカバーしない（`auth.spec.ts` は API レベルの
 * proxy モード検証のみを行っており、ブラウザ UI は none モード専用）。
 */

/**
 * `container` 配下の要素のうち、水平方向に overflow しているもの（scrollWidth が
 * clientWidth を一定以上超えるもの）を探す。`i18nScheduleAlertLayout.spec.ts` と
 * 同一の実装（Tooltip の非表示中 scrollWidth 混入を避けるための一時 display:none 処理を含む）。
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
 * インデックス連結）をキーにして返す。`i18nScheduleAlertLayout.spec.ts` と同一の
 * 実装（要素ごとの日英対応比較用）。
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
 * 悪化していないかを検証する。`i18nScheduleAlertLayout.spec.ts` と同一の実装
 * （SavedQueriesPanel の SQL 一行要約 `<p>` のように、i18n と無関係な
 * 既存の overflow（components/panels/ 配下、本フェーズの対象外）が既に
 * 英語版から存在する箇所を絶対値ゼロ判定で誤検知しないための対応比較）。
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
 * LocaleToggle をクリックして言語を切り替える。`data-testid="locale-toggle"` は
 * 表示テキストがロケールで変わっても不変なので、これで特定する。
 */
async function switchLocale(page: Page): Promise<void> {
  await page.getByTestId('locale-toggle').click();
}

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('TopBar: 主要ボタンが英語(既定)→日本語切替で翻訳され、overflowしない', async ({ page }) => {
  const header = page.locator('header').first();

  // 既定（英語）。
  await expect(page.getByRole('button', { name: 'Run', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  const offendersEn = await findHorizontalOverflow(page, 'header');
  expect(offendersEn, JSON.stringify(offendersEn)).toEqual([]);

  // テーマ切替ボタン押下でトーストが出ることも確認する（英語）。
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.getByText('Theme preference saved.')).toBeVisible();
  // 元に戻す。
  await page.getByRole('button', { name: 'Light theme' }).click();

  await switchLocale(page);

  // 日本語化後は「実行」「保存」に翻訳される。
  await expect(page.getByRole('button', { name: '実行', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '保存', exact: true })).toBeVisible();
  await expect(header.getByRole('button', { name: 'Run', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'ダークテーマ' }).click();
  await expect(page.getByText('テーマ設定を保存しました。')).toBeVisible();
  await page.getByRole('button', { name: 'ライトテーマ' }).click();

  const offendersJa = await findHorizontalOverflow(page, 'header');
  expect(offendersJa, JSON.stringify(offendersJa)).toEqual([]);
});

test('TopBar: ノートブックタブの新規追加ボタンとクローズ確認モーダルが翻訳される', async ({
  page,
}) => {
  await switchLocale(page);

  // 「新規ノートブック」ボタン自体は aria-label のみ確認する（クリックすると
  // 「Untitled notebook」という同名タブが2つ並び、閉じるボタンの一意特定が
  // 難しくなるため、実際にクリックはしない）。
  await expect(page.getByRole('button', { name: '新規ノートブック' })).toBeVisible();

  // resetWorkspace で開かれる既定の1タブを編集して dirty にする（未編集のままだと
  // 確認モーダルを経由せず即座に閉じてしまい、モーダルの翻訳を検証できないため）。
  await setEditor(page, 0, 'SELECT 1');
  await expect(page.getByLabel('未保存の変更')).toBeVisible();

  await page
    .getByRole('button', { name: /^.+ を閉じる$/ })
    .first()
    .click();

  const dialog = page.getByRole('dialog', { name: 'ノートブックを閉じますか?' });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('には未保存の変更があります。閉じると破棄されます。'),
  ).toBeVisible();
  await dialog.getByRole('button', { name: '破棄して閉じる' }).click();
  await expect(dialog).toBeHidden();
});

test('ContextSelector: ポップオーバーの文言が翻訳され、overflowしない', async ({ page }) => {
  await page.getByRole('button', { name: 'catalog.schema context' }).click();
  const dialogEn = page.getByRole('dialog', { name: 'Select context' });
  await expect(dialogEn).toBeVisible();
  await expect(dialogEn.getByText('Catalog', { exact: true })).toBeVisible();
  await expect(dialogEn.getByText('Schema', { exact: true })).toBeVisible();
  const offendersEn = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersEn, JSON.stringify(offendersEn)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialogEn).toBeHidden();

  await switchLocale(page);

  await page.getByRole('button', { name: 'catalog.schema コンテキスト' }).click();
  const dialogJa = page.getByRole('dialog', { name: 'コンテキストを選択' });
  await expect(dialogJa).toBeVisible();
  await expect(dialogJa.getByText('カタログ', { exact: true })).toBeVisible();
  await expect(dialogJa.getByText('スキーマ', { exact: true })).toBeVisible();
  const offendersJa = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersJa, JSON.stringify(offendersJa)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(dialogJa).toBeHidden();
});

test('Sidebar: 各パネルのレール/見出し/検索欄が日英で翻訳され、overflowしない', async ({
  page,
}) => {
  // Schedules/Alerts は i18nScheduleAlertLayout.spec.ts で既に検証済みなので、
  // ここでは Operations（権限が必要で既定では非表示）を除く残りのタブを確認する。
  // Data は resetWorkspace の既定アクティブタブ(既に開いた状態で読み込まれる)なので
  // 配列の先頭には置かない。既定アクティブなタブを再クリックすると
  // Sidebar のレールボタンは「同じタブの再クリック=折りたたみ」の仕様
  // （Sidebar.tsx の toggleSidebar 分岐）により閉じてしまい、パネルが消えて
  // しまうため、先に別タブへ切り替えてから Data を訪れる順序にしている。
  const tabs: {
    en: string;
    ja: string;
    headingEn: string;
    headingJa: string;
    placeholderEn?: string;
    placeholderJa?: string;
    // overflow の要素単位対応比較をスキップするタブ（下記コメント参照）。
    skipOverflowCheck?: true;
  }[] = [
    {
      en: 'Notebooks',
      ja: 'ノートブック',
      headingEn: 'Notebooks',
      headingJa: 'ノートブック',
      placeholderEn: 'Search notebooks…',
      placeholderJa: 'ノートブックを検索…',
    },
    {
      en: 'Data',
      ja: 'データ',
      headingEn: 'Data browser',
      headingJa: 'データブラウザ',
      placeholderEn: 'Filter tables…',
      placeholderJa: 'テーブルを絞り込み…',
    },
    // 見出しは「保存済みクエリ」でレールとは別文言。overflow の要素単位比較は
    // スキップする: SavedQueriesPanel（components/panels/、本フェーズの対象外）の
    // SQL 一行要約 <p> が、E2E 実行を重ねてこのタブに保存済みクエリが多数
    // 蓄積した状態だと、ロケールに関係なく（英語でも）truncate が効かず
    // overflow する既存の挙動を確認した（flex-wrap 配下の flex-1 truncate が
    // 蓄積件数依存でレイアウトタイミングにより不安定になる模様）。i18n による
    // regression ではないため、翻訳確認（rail ラベル/見出し）はこのタブでも
    // 行うが、overflow 比較だけは対象外とする。
    {
      en: 'Saved',
      ja: '保存済み',
      headingEn: 'Saved queries',
      headingJa: '保存済みクエリ',
      skipOverflowCheck: true,
    },
    // History は検索欄なし。
    { en: 'History', ja: '履歴', headingEn: 'History', headingJa: '履歴' },
    {
      en: 'Dashboards',
      ja: 'ダッシュボード',
      headingEn: 'Dashboards',
      headingJa: 'ダッシュボード',
      placeholderEn: 'Search dashboards…',
      placeholderJa: 'ダッシュボードを検索…',
    },
    {
      en: 'Workflows',
      ja: 'ワークフロー',
      headingEn: 'Workflows',
      headingJa: 'ワークフロー',
      placeholderEn: 'Search workflows…',
      placeholderJa: 'ワークフローを検索…',
    },
  ];

  // タブごとに英語版の overflow マップを先に取っておき、日本語版と要素単位で
  // 対応比較する（絶対値ゼロ判定だと、Saved パネルの SQL 一行要約のような
  // i18n と無関係な既存 overflow（SavedQueriesPanel、本フェーズの対象外）を
  // 誤って regression と報告してしまうため）。パネル見出し（h2）の可視化を
  // 毎回明示的に待つことで、検索欄を持たないタブ（Saved/History）でも
  // パネル切り替えの描画が完了してから計測する（未完了のまま計測すると
  // レイアウトが安定する前の過渡的な幅を拾ってしまい、日英で無関係な
  // 差分が出ることがあったための対応）。
  const enByTab: Record<string, Record<string, { tag: string; overflowPx: number }>> = {};
  for (const tabInfo of tabs) {
    await page.getByRole('button', { name: tabInfo.en, exact: true }).click();
    await expect(page.getByRole('heading', { name: tabInfo.headingEn, level: 2 })).toBeVisible();
    if (tabInfo.placeholderEn) {
      await expect(page.getByPlaceholder(tabInfo.placeholderEn)).toBeVisible();
    }
    if (!tabInfo.skipOverflowCheck) {
      enByTab[tabInfo.en] = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');
    }
  }

  await switchLocale(page);

  for (const tabInfo of tabs) {
    await page.getByRole('button', { name: tabInfo.ja, exact: true }).click();
    await expect(page.getByRole('heading', { name: tabInfo.headingJa, level: 2 })).toBeVisible();
    if (tabInfo.placeholderJa) {
      await expect(page.getByPlaceholder(tabInfo.placeholderJa)).toBeVisible();
    }
    if (!tabInfo.skipOverflowCheck) {
      const offendersJa = await measureOverflowByPath(page, '[data-testid="sidebar-panel"]');
      expectNoOverflowRegression(`Sidebar/${tabInfo.en}`, enByTab[tabInfo.en]!, offendersJa);
    }
  }
  // パネル見出し（data/saved はレールと異なる文言を持つ）は上のループで
  // 各タブの heading 可視化チェックに含めて既に検証済み。
});

test('ShareModal: 保存済みクエリの共有先編集が日英で翻訳され、overflowしない', async ({
  page,
  request,
}) => {
  const name = `i18n share ${rnd()}`;
  await seedSavedQuery(request, {
    name,
    description: 'E2E seeded for i18n layout (share modal).',
    statement: 'SELECT count(*) AS n FROM tpch.tiny.nation',
  });

  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  const row = page.getByText(name).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  await page.getByRole('button', { name: 'Share', exact: true }).click();
  const dialogEn = page.getByRole('dialog', { name: 'Share' });
  await expect(dialogEn).toBeVisible();
  await expect(dialogEn.getByText('Type', { exact: true })).toBeVisible();
  await expect(dialogEn.getByText('Subject', { exact: true })).toBeVisible();
  await expect(dialogEn.getByText('Permission', { exact: true })).toBeVisible();
  const offendersEn = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersEn, JSON.stringify(offendersEn)).toEqual([]);
  await dialogEn.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialogEn).toBeHidden();

  await switchLocale(page);

  // 起動元の「Share」ボタン（SavedQueriesPanel）は、その後の i18n Phase 2c
  // （パネル群の localize）で翻訳対象になったため、日本語ロケールでは「共有」
  // ボタンとして現れる（このテスト作成時点の想定から変わった点）。
  await page.getByRole('button', { name: '共有', exact: true }).click();
  const dialogJa = page.getByRole('dialog', { name: '共有' });
  await expect(dialogJa).toBeVisible();
  await expect(dialogJa.getByText('種別', { exact: true })).toBeVisible();
  await expect(dialogJa.getByText('対象', { exact: true })).toBeVisible();
  await expect(dialogJa.getByText('権限', { exact: true })).toBeVisible();
  const offendersJa = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersJa, JSON.stringify(offendersJa)).toEqual([]);
  await dialogJa.getByRole('button', { name: 'キャンセル', exact: true }).click();
  await expect(dialogJa).toBeHidden();
});

test('ShortcutsHelp: コマンドパレット経由で開いたヘルプが日英で翻訳され、overflowしない', async ({
  page,
}) => {
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('Type a command…').fill('Keyboard shortcuts');
  await page
    .getByRole('dialog', { name: 'Command palette' })
    .getByText('Keyboard shortcuts')
    .first()
    .click();

  const helpEn = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(helpEn).toBeVisible();
  await expect(helpEn.getByText('Run the active cell')).toBeVisible();
  await expect(
    helpEn.getByText('On macOS, ⌘ stands in for Ctrl. Run, format and save also work'),
  ).toBeVisible();
  const offendersEn = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersEn, JSON.stringify(offendersEn)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(helpEn).toBeHidden();

  await switchLocale(page);

  // CommandPalette 自体（components/palette/）は、その後の i18n Phase 2c で
  // localize 済みになったため、日本語ロケールではダイアログ名/placeholder/
  // コマンド名も日本語で開く（このテスト作成時点の想定から変わった点）。
  // 開いた先の ShortcutsHelp 本体が日本語化されていることを確認する。
  await page.keyboard.press('Control+k');
  await page.getByPlaceholder('コマンドを入力…').fill('キーボードショートカット');
  await page
    .getByRole('dialog', { name: 'コマンドパレット' })
    .getByText('キーボードショートカット')
    .first()
    .click();

  const helpJa = page.getByRole('dialog', { name: 'キーボードショートカット' });
  await expect(helpJa).toBeVisible();
  await expect(helpJa.getByText('アクティブなセルを実行')).toBeVisible();
  await expect(helpJa.getByText('macOS では、⌘ が Ctrl の代わりになります。')).toBeVisible();
  const offendersJa = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersJa, JSON.stringify(offendersJa)).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(helpJa).toBeHidden();
});

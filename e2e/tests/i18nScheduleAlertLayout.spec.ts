import { test, expect, type Page } from '@playwright/test';
import { resetWorkspace, seedSavedQuery, seedSchedule, seedAlert, rnd } from './helpers';

/**
 * i18n 第 1 フェーズ（Schedule / Alert 領域）の実ブラウザ検証。
 *
 * jsdom ベースの単体テスト（`i18nLocaleSwitch.test.tsx`）では、翻訳キーが正しい
 * ロケールの文字列に切り替わることまでは検証できるが、実際にレイアウトが崩れて
 * いないか（日英で文字数が大きく変わるラベルによる overflow）は計算されたレイアウト
 * を持つ実ブラウザでしか確認できない。このスイートは Schedule / Alert の作成モーダルを
 * 日本語/英語の両ロケールで開き、(a) モーダル内の主要要素が横方向に overflow していない
 * こと、(b) ロケール切替で実際にラベルが翻訳されることを確認する。
 * `notebookHeaderLayout.spec.ts` を実ブラウザ計測の前例としている。
 */

/**
 * `container` 配下の要素のうち、水平方向に overflow しているもの（scrollWidth が
 * clientWidth を一定以上超えるもの）を探し、デバッグしやすいよう tagName とテキストの
 * 断片を添えて返す。1px 未満の丸め誤差はスクロールバー等のノイズなので許容する。
 *
 * `Tooltip.tsx`（role="tooltip"）は常時 DOM 上に存在し、非表示時も `position: absolute`
 * + `opacity: 0` で配置される。opacity は要素をレイアウトから外さないため、親要素の
 * `scrollWidth` にはホバー前でもツールチップ本文の幅が算入され、実際には崩れていない
 * 箇所を偽陽性として検出してしまう。このため計測前に `[role="tooltip"]` を一時的に
 * `display: none` にしてから scrollWidth を測り、測定後に元へ戻す。
 */
async function findHorizontalOverflow(
  page: Page,
  containerSelector: string,
): Promise<{ tag: string; text: string; overflowPx: number }[]> {
  return page.evaluate((selector) => {
    const root = document.querySelector(selector);
    if (!root) return [];

    // Tooltip 本体を計測対象から一時的に除外する（後で必ず元に戻す）。
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
 * LocaleToggle をクリックして言語を切り替える。ボタンの可視テキストは現在ロケール
 * （"EN"/"JA"）そのものであり、aria-label（切替先を表す文言）とは異なるため、
 * ロケールに依存しない `data-testid="locale-toggle"` で特定する。モーダルの背後にある
 * バックドロップにクリックを遮られるため、呼び出し前にモーダルを閉じておくこと。
 */
async function switchToJapanese(page: Page): Promise<void> {
  await page.getByTestId('locale-toggle').click();
}

test.beforeEach(async ({ page }) => {
  await resetWorkspace(page);
});

test('Schedule 作成モーダル: 英語(既定)→日本語切替でラベルが翻訳され、どちらでも overflow しない', async ({
  page,
}) => {
  await page.getByRole('button', { name: 'Schedules', exact: true }).click();

  // モーダルのタイトルはロケールで変わる（"New schedule" / "新規スケジュール"）ため、
  // dialog ロケーター自体は名前で絞らず role のみで取得する（同時に開くのは1つだけ）。
  const dialog = page.getByRole('dialog');
  const openButton = page.getByRole('button', { name: /^(New schedule|新規スケジュール)$/ });

  await openButton.click();
  await expect(dialog).toBeVisible();
  // 既定（Playwright の Chromium は en-US ロケール）では英語表記のまま。
  await expect(dialog.getByText('Retry policy')).toBeVisible();
  await expect(dialog.getByText('Failure notifications')).toBeVisible();

  const offendersEn = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersEn, JSON.stringify(offendersEn)).toEqual([]);

  // ロケール切替トグルは TopBar 側にあり、モーダルの背後にあるバックドロップに
  // クリックが遮られるため、いったんモーダルを閉じてから切り替える。
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await switchToJapanese(page);

  // 日本語で再度モーダルを開き、フォーム内ラベルが翻訳されていることを確認する。
  await openButton.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('リトライポリシー')).toBeVisible();
  await expect(dialog.getByText('失敗時の通知')).toBeVisible();

  const offendersJa = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersJa, JSON.stringify(offendersJa)).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

/**
 * `container` 配下の全要素の overflowPx を、DOM 構造上の位置（ルートからの子要素
 * インデックス連結。例 "0.2.1"）をキーにして返す。英語版と日本語版で DOM の形
 * （要素の数と入れ子構造）はテキスト以外変わらないため、このキーで「同じ要素」を
 * ロケールをまたいで対応付けられる。`findHorizontalOverflow` と同じ理由で
 * `[role="tooltip"]` は測定から一時的に除外する。
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
 * 悪化していないかを検証する（要素ごとの対応比較）。
 *
 * 「全要素の中の最大値」同士を比較する方式だと、英語版で既に overflow している
 * 要素 A（例: 狭いサイドバー幅でのホバー専用アクション列。i18n とは無関係な
 * 既存の特性）が基準値を底上げしてしまい、日本語版でだけ新たに overflow する
 * 別要素 B の regression が最大値の下に隠れて検出されない問題があった
 * （レビュー指摘）。要素ごとの対応比較ならこれを見逃さない。
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

test('SchedulesPanel/AlertsPanel の行表示、状態バッジ、実行履歴モーダル、TopBar が日本語化で overflow を悪化させない', async ({
  page,
  request,
}) => {
  // 行に実データ（状態バッジ、cron、次回実行表示）が乗った状態で崩れないか検証する
  // ため、Schedule と Alert をそれぞれ 1 件、API 経由で投入しておく。
  const scheduleName = `i18n layout schedule ${rnd()}`;
  await seedSchedule(request, {
    name: scheduleName,
    statement: 'SELECT count(*) FROM tpch.tiny.nation',
  });
  const savedQueryId = await seedSavedQuery(request, {
    name: `i18n layout source ${rnd()}`,
    statement: 'SELECT count(*) AS n FROM tpch.tiny.nation',
  });
  const alertName = `i18n layout alert ${rnd()}`;
  await seedAlert(request, {
    name: alertName,
    savedQueryId,
    columnName: 'n',
    op: '>',
    value: '0',
  });

  // TopBar（JA/EN トグルを含む）は常時表示されているので、Schedules パネルを開いた
  // 時点でまとめて検証する。
  await page.getByRole('button', { name: 'Schedules', exact: true }).click();
  await expect(page.getByText(scheduleName)).toBeVisible({ timeout: 10_000 });

  // ---- 英語（既定）のベースラインを取る ----
  // TopBar と ScheduleRunsModal（空状態）は今回 flex-wrap 等で個別に手を入れていない
  // 領域なので、要素ごとの対応比較（英語版比で悪化していないか）で検証する。
  const topBarEn = await measureOverflowByPath(page, 'header');
  // SchedulesPanel/AlertsPanel の行アクション列は flex-wrap 修正済みなので、
  // 英語版の時点でも絶対値ゼロを確認しておく（修正が効いていることの直接証拠）。
  const sidebarScheduleEn = await findHorizontalOverflow(page, '[data-testid="sidebar-panel"]');
  expect(sidebarScheduleEn, JSON.stringify(sidebarScheduleEn)).toEqual([]);

  await page.getByText(scheduleName).click();
  const runsDialog = page.getByRole('dialog');
  await expect(runsDialog).toBeVisible();
  await expect(runsDialog.getByText('No runs yet')).toBeVisible();
  const runsDialogEn = await measureOverflowByPath(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(runsDialog).toBeHidden();

  await page.getByRole('button', { name: 'Alerts', exact: true }).click();
  await expect(page.getByText(alertName)).toBeVisible({ timeout: 10_000 });
  const sidebarAlertEn = await findHorizontalOverflow(page, '[data-testid="sidebar-panel"]');
  expect(sidebarAlertEn, JSON.stringify(sidebarAlertEn)).toEqual([]);

  // ---- 日本語へ切替し、同じ画面で再計測する ----
  await switchToJapanese(page);

  // Sidebar のアイコンレール自体は Phase 2b で日本語化されたため、ここから先は
  // 「スケジュール」「アラート」の翻訳済みラベルでレールボタンを特定する
  // （Phase 1 執筆時点では Sidebar 未翻訳だったための旧コメントを更新）。
  await page.getByRole('button', { name: 'スケジュール', exact: true }).click();
  await expect(page.getByText(scheduleName)).toBeVisible({ timeout: 10_000 });
  const topBarJa = await measureOverflowByPath(page, 'header');
  // SchedulesPanel の行アクション列は今回 flex-wrap を追加して修正済みの領域なので、
  // 英語版比の相対比較ではなく絶対値ゼロで検証する（レビュー指摘）。
  const sidebarScheduleJa = await findHorizontalOverflow(page, '[data-testid="sidebar-panel"]');
  expect(sidebarScheduleJa, JSON.stringify(sidebarScheduleJa)).toEqual([]);

  await page.getByText(scheduleName).click();
  await expect(runsDialog).toBeVisible();
  await expect(runsDialog.getByText('まだ実行履歴がありません')).toBeVisible();
  const runsDialogJa = await measureOverflowByPath(page, '[role="dialog"]');
  await page.keyboard.press('Escape');
  await expect(runsDialog).toBeHidden();

  await page.getByRole('button', { name: 'アラート', exact: true }).click();
  await expect(page.getByText(alertName)).toBeVisible({ timeout: 10_000 });
  // AlertsPanel の行アクション列も同じ理由で絶対値ゼロで検証する。
  const sidebarAlertJa = await findHorizontalOverflow(page, '[data-testid="sidebar-panel"]');
  expect(sidebarAlertJa, JSON.stringify(sidebarAlertJa)).toEqual([]);

  expectNoOverflowRegression('TopBar', topBarEn, topBarJa);
  expectNoOverflowRegression('ScheduleRunsModal (empty state)', runsDialogEn, runsDialogJa);
});

test('Alert 作成モーダル: 英語(既定)→日本語切替で「しきい値」ラベルが表示され、どちらでも overflow しない', async ({
  page,
  request,
}) => {
  // Alert の New ボタンは保存済みクエリが 1 件も無いと disabled のままなので、先に 1 件作る。
  const name = `Alert source ${rnd()}`;
  await seedSavedQuery(request, {
    name,
    description: 'E2E seeded for alert i18n layout test.',
    statement: 'SELECT count(*) AS n FROM tpch.tiny.nation',
  });

  await page.getByRole('button', { name: 'Alerts', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const openButton = page.getByRole('button', { name: /^(New alert|新規アラート)$/ });
  await expect(openButton).toBeEnabled({ timeout: 10_000 });

  await openButton.click();
  await expect(dialog).toBeVisible();
  // 既定（英語）では従来どおり "Threshold"（ユーザー指摘の起点になったラベル）。
  await expect(dialog.getByText('Threshold', { exact: true })).toBeVisible();

  const offendersEn = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersEn, JSON.stringify(offendersEn)).toEqual([]);

  // ロケール切替は背後の TopBar にあり、開いたままだとバックドロップにクリックが
  // 遮られるため、いったん閉じてから切り替える。
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await switchToJapanese(page);

  // 日本語へ切替すると、非エンジニアにも分かる「しきい値」表記になる
  // （ユーザー指摘: THRESHOLD が非エンジニアに分からない、への直接の対応）。
  await openButton.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('しきい値', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Threshold', { exact: true })).toHaveCount(0);

  const offendersJa = await findHorizontalOverflow(page, '[role="dialog"]');
  expect(offendersJa, JSON.stringify(offendersJa)).toEqual([]);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

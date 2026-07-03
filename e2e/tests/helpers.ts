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
 *
 * E2E テスト全体で共有するヘルパー関数群を定義するファイル。
 * P3〜P5 のスクリーンショットスクリプトで確立された操作パターンを、
 * テスト用ユーティリティとしてラップし直したもの。すべての待機処理は
 * ネットワーク応答や DOM/状態の条件に紐づけられており（固定時間の
 * `waitForTimeout` は使わない）、実際の Trino に対してもフレーキーにならない。
 *
 * 規約
 *  - 各テストはワークスペース（テーマ、サイドバー、下書き）をリセットし、
 *    実行順序や開発者ローカルの永続状態に依存しないようにする。
 *  - 複数行の SQL は、開発専用フック `window.__fableEditors` 経由で Monaco の
 *    モデルに直接流し込む。キーボードで打鍵する方式は自動インデントや
 *    補完候補の自動確定によって内容が崩れるため信頼できない。一方、
 *    Ctrl+Enter のような単発キー操作は実際のキーボード経路を通す。
 */

/** テストで共通利用する既定のカタログとスキーマ（tpch.tiny）。 */
export const TINY = { catalog: 'tpch', schema: 'tiny' };

/**
 * A unique-ish suffix so notebooks / saved queries created by a test don't collide.
 * テストが作成するノートブックや保存済みクエリの名前が衝突しないようにするための、
 * ほぼ一意なサフィックス文字列を生成する。
 */
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
 *
 * ブラウザに永続化された状態を既知のベースラインにリセットしてからアプリを
 * 読み込む。下書きノートブックやワークスペースのスナップショットを
 * （センチネル値でガードして）一度だけクリアし、テーマとサイドバーの状態を
 * 設定したうえで、直近コンテキストを tpch.tiny にシードして新規ノートブックの
 * 既定値がそこになるようにする。
 *
 * クリア処理を一度だけにしているのは、後続の `page.reload()` でアプリが
 * 直前に永続化したワークスペースのスナップショットを保持し続けるようにするため
 * （これにより「保存 → リロード → 復元」のテストが成立する）。init script 自体は
 * ページ遷移のたびに実行されるが、センチネルが存在しない場合のみクリアを行う。
 */
export async function resetWorkspace(
  page: Page,
  opts: { theme?: 'light' | 'dark'; sidebarTab?: string; context?: { catalog: string; schema: string } } = {},
): Promise<void> {
  // テーマ、サイドバータブ、既定コンテキストのデフォルト値を決定する。
  const theme = opts.theme ?? 'light';
  const sidebarTab = opts.sidebarTab ?? 'data';
  const context = opts.context ?? TINY;
  // ページ読み込み前に実行される初期化スクリプトを登録する。
  await page.addInitScript(
    ({ theme, sidebarTab, context }) => {
      try {
        // このセンチネルキーが無い場合のみ、localStorage を一度だけクリアする。
        const SENTINEL = '__e2e_reset__';
        if (!window.localStorage.getItem(SENTINEL)) {
          window.localStorage.clear();
          // 以降のページ遷移でクリアが再実行されないようにマークする。
          window.localStorage.setItem(SENTINEL, '1');
          // UI ストアの初期状態（テーマやサイドバー幅など）を直接書き込む。
          window.localStorage.setItem(
            'hubble-ui',
            JSON.stringify({
              state: { theme, sidebarTab, sidebarWidth: 320, sidebarCollapsed: false },
              version: 0,
            }),
          );
          // 直近使用コンテキストを既定のカタログ/スキーマにシードする。
          window.localStorage.setItem('hubble-recent-contexts', JSON.stringify([context]));
        }
      } catch {
        /* ignore */
      }
      // The app's UI store applies `data-theme` from the persisted `hubble-ui`
      // entry on load, so we don't touch documentElement here (it may not exist
      // yet at document_start, and throwing would abort the init script).
      // アプリの UI ストアが読み込み時に `hubble-ui` の内容から `data-theme` を
      // 適用するため、ここでは documentElement を直接操作しない
      // （document_start 時点ではまだ存在しない可能性があり、例外を投げると
      // init script 全体が中断してしまうため）。
    },
    { theme, sidebarTab, context },
  );
  // アプリのトップページへ遷移する。
  await page.goto('/');
  // Monaco エディタが初期化されるまで待機してからテストを続行する。
  await waitEditorReady(page);
}

/**
 * Wait until at least one Monaco editor has mounted and registered its language.
 * 少なくとも 1 つの Monaco エディタがマウントされ、言語登録が完了するまで待機する。
 */
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
 *
 * n 番目の「表示中」SQL セルの本文全体を、その Monaco モデル経由で書き換え
 * （かつフォーカスも当てる）。エディタへのアクセスはホストの DOM ノード
 * （`[data-testid="sql-editor"]`.__fableEditor）を介して行う。これにより
 * セルの削除や並び替えが発生しても正しく対象を特定できる。
 * グローバルな `__fableEditors` 配列はマウント順に依存しており、
 * 状態が古くなりやすいため使わない。
 *
 * `setValue` は Monaco の change イベントを同期的に発火し、セルはそれを
 * notebook ストアへ転送する。そのため、その後アニメーションフレームを
 * 2 回分待つことで React による再レンダリングのコミットを確実に待つ
 * （これにより、以降のアサーションやクリックが新しい本文を正しく
 * 反映した状態（例えば削除確認の閾値や変数パネル）を見られるようにする）。
 */
export async function setEditor(page: Page, index: number, text: string): Promise<void> {
  // 対象インデックスのエディタが DOM 上に現れるまで待つ。
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
      // Monaco モデルの全文を差し替える。
      editor.setValue(value);
      // 差し替え後、カーソルを本文末尾に移動させる。
      const model = editor.getModel();
      if (model) {
        const last = model.getLineCount();
        editor.setPosition({ lineNumber: last, column: model.getLineMaxColumn(last) });
      }
      editor.focus();
      // Let React flush the store-driven re-render before the test proceeds.
      // テストを先に進める前に、ストア更新に伴う React の再レンダリングが
      // 確実にコミットされるよう、アニメーションフレームを 2 回分待つ。
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    },
    { index, value: text },
  );
}

/**
 * Read the nth visible SQL cell's current Monaco value.
 * n 番目の表示中 SQL セルの、現在の Monaco 本文を取得する。
 */
export async function getEditorValue(page: Page, index = 0): Promise<string> {
  return page.evaluate((index) => {
    const hosts = document.querySelectorAll('[data-testid="sql-editor"]');
    const host = hosts[index] as (Element & { __fableEditor?: { getValue: () => string } }) | undefined;
    return host?.__fableEditor?.getValue() ?? '';
  }, index);
}

/**
 * Place the caret of the nth visible SQL cell at an absolute line/column.
 * n 番目の表示中 SQL セルのキャレット位置を、絶対行と列で指定した位置に移動する。
 */
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

/**
 * The nth notebook cell wrapper.
 * n 番目のノートブックセル全体のラッパー要素を取得する。
 */
export function cell(page: Page, index = 0): Locator {
  return page.getByTestId('notebook-cell').nth(index);
}

/**
 * Open the command palette and wait for its input.
 * コマンドパレットを開き、その入力欄が表示されるまで待つ。
 */
export async function openPalette(page: Page): Promise<Locator> {
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder('Type a command…');
  await expect(input).toBeVisible();
  return input;
}

/**
 * Run a palette command by name (waits for the option, then activates it).
 * 指定した名前のコマンドをパレットから実行する（選択肢の表示を待ってからクリックする）。
 */
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
 *
 * コマンドパレット経由で指定種別のセルを追加し、セル数が増えるまで待つ。
 * 追加後の総セル数を返す。
 */
export async function addCell(page: Page, kind: 'sql' | 'markdown'): Promise<number> {
  const before = await page.getByTestId('notebook-cell').count();
  await runPaletteCommand(page, kind === 'sql' ? 'New SQL cell' : 'New Markdown cell');
  await expect(page.getByTestId('notebook-cell')).toHaveCount(before + 1);
  return before + 1;
}

/**
 * Run the focused editor via Ctrl+Enter. Assumes the editor already has focus.
 * Ctrl+Enter でフォーカス中のエディタを実行する。事前にエディタへフォーカスが
 * 当たっていることを前提とする。
 */
export async function runFocused(page: Page): Promise<void> {
  await page.keyboard.press('Control+Enter');
}

/**
 * Focus the SQL editor of cell #index and run it (Ctrl+Enter). Returns once the
 * keystroke is dispatched — callers await a concrete result/state afterwards.
 *
 * index 番目のセルの SQL エディタにフォーカスし、Ctrl+Enter で実行する。
 * この関数自体はキー入力を発行した時点で返るため、呼び出し側は必要に応じて
 * 具体的な結果や状態を別途待つこと。
 */
export async function runCell(page: Page, index = 0): Promise<void> {
  await cell(page, index).locator('[data-testid="sql-editor"]').click();
  await page.keyboard.press('Control+Enter');
}

/**
 * Locator for a cell's result pane.
 * セルの結果表示ペインの Locator を取得する。
 */
export function resultPane(page: Page, index = 0): Locator {
  return cell(page, index).getByTestId('result-pane');
}

/**
 * Wait for a cell's StateBadge to read FINISHED (terminal-success).
 * セルの StateBadge が FINISHED（成功終端状態）を表示するまで待つ。
 */
export async function expectFinished(page: Page, index = 0): Promise<void> {
  await expect(cell(page, index).getByText('FINISHED', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Wait for the result grid + its "N rows · M columns" footer to settle.
 * 結果グリッドと、その「N rows · M columns」フッター表示が安定するまで待つ。
 */
export async function waitGrid(page: Page, index = 0): Promise<void> {
  const pane = resultPane(page, index);
  // Grid タブに切り替える。
  await pane.getByRole('tab', { name: 'Grid' }).click();
  // グリッド本体が描画されるまで待つ。
  await pane.getByTestId('result-grid').waitFor({ timeout: 30_000 });
  // 行数と列数のフッター文言が表示されるまで待つ（描画完了の目印）。
  await expect(pane.getByText(/\d[\d,]* rows · \d+ columns/).first()).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * Run cell #index and wait for the grid to be populated.
 * index 番目のセルを実行し、結果グリッドが表示されるまで待つ一連の流れをまとめたヘルパー。
 */
export async function runCellToGrid(page: Page, index = 0): Promise<void> {
  await runCell(page, index);
  await expectFinished(page, index);
  await waitGrid(page, index);
}

/**
 * Switch a cell's result pane to a named tab.
 * セルの結果ペインを指定タブに切り替える。
 */
export async function openResultTab(
  page: Page,
  tab: 'Grid' | 'Chart' | 'Explain' | 'Details',
  index = 0,
): Promise<void> {
  await resultPane(page, index).getByRole('tab', { name: tab }).click();
}

// ---- Server-side seeding (via the proxied API, deterministic) --------------
// ---- server 側での事前データ投入（プロキシ経由の API 呼び出し、決定的） ----

/** `seedSavedQuery` に渡す、保存済みクエリのシードデータ形状。 */
export interface SeedSavedQuery {
  name: string;
  description?: string;
  statement: string;
  catalog?: string;
  schema?: string;
  isFavorite?: boolean;
}

/**
 * Create a saved query through the API; returns its id.
 * API 経由で保存済みクエリを作成し、その id を返す（UI 操作を介さないため高速かつ決定的）。
 */
export async function seedSavedQuery(
  request: APIRequestContext,
  q: SeedSavedQuery,
): Promise<string> {
  const res = await request.post('/api/saved-queries', { data: { catalog: 'tpch', schema: 'tiny', ...q } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).id as string;
}

/**
 * Run a statement to a terminal state through the API (so it lands in history).
 * API 経由で SQL 文を終端状態まで実行する（実行履歴に記録させるためのヘルパー）。
 */
/**
 * データソースセレクタを開く。
 */
export async function openDatasourceMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Data source' }).click();
}

/**
 * TopBar のデータソースを displayName で切り替える。
 */
export async function selectDatasource(page: Page, displayName: string): Promise<void> {
  await openDatasourceMenu(page);
  await page.getByRole('option').filter({ hasText: displayName }).first().click();
}

/**
 * demo-postgres へ到達できるか API で確認する (MULTI_DS_E2E 用)。
 */
export async function isPostgresDemoReachable(request: APIRequestContext): Promise<boolean> {
  try {
    const res = await request.post('/api/queries', {
      data: { statement: 'SELECT 1', datasourceId: 'postgres-demo', source: 'hubble' },
    });
    if (res.status() !== 202) return false;
    const { queryId } = (await res.json()) as { queryId: string };
    for (let i = 0; i < 40; i++) {
      const snap = (await request.get(`/api/queries/${queryId}`).then((r) => r.json())) as {
        state: string;
      };
      if (snap.state === 'finished') return true;
      if (['failed', 'canceled'].includes(snap.state)) return false;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  } catch {
    return false;
  }
}

export async function runToHistory(
  request: APIRequestContext,
  statement: string,
  ctx = TINY,
): Promise<string> {
  // クエリ実行を開始する。
  const res = await request.post('/api/queries', {
    data: { statement, ...ctx, source: 'hubble' },
  });
  const { queryId } = await res.json();
  // 終端状態に達するまで、最大 120 回（約 24 秒）ポーリングする。
  for (let i = 0; i < 120; i++) {
    const snap = await request.get(`/api/queries/${queryId}`).then((r) => r.json());
    if (['finished', 'failed', 'canceled'].includes(snap.state)) return snap.state;
    await new Promise((r) => setTimeout(r, 200));
  }
  // タイムアウトした場合は 'timeout' を返す（呼び出し側で失敗として扱う想定）。
  return 'timeout';
}

#!/usr/bin/env node
/**
 * ワークフローキャンバスのスクリーンショットを撮影するスクリプト。
 *
 * - サーバー (packages/server) と web dev サーバー (vite) を自動起動し、
 *   撮影後に停止する。
 * - API でサンプルワークフロー ("Daily sales report") を作成・実行し、
 *   完了後に Playwright でキャンバス画面を docs/screenshots/workflow-canvas.png に保存する。
 * - ステージ 1 (集計) → ステージ 2 (地域別売上 + 上位顧客、並行) →
 *   ステージ 3 (Notify) の 4 ステップ構成。
 *
 * 前提: localhost:8090 で Trino (tpch catalog) が稼働していること。
 * 実行: node e2e/screenshots-workflow.mjs [webBaseURL]
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = resolve(repoRoot, 'docs/screenshots');

const BASE_URL = process.argv[2] ?? 'http://localhost:5173';
// サーバーが待ち受けるポート。web dev サーバーの /api プロキシ先にもなる。
const SERVER_PORT = 8081;
const SERVER_URL = `http://localhost:${SERVER_PORT}`;
const VIEWPORT = { width: 1440, height: 900 };

/** コマンドを起動し、完了を Promise で返す。 */
function run(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('exit', (code) =>
      code === 0 ? res() : rej(new Error(`${cmd} ${args.join(' ')} exited ${code}`)),
    );
    child.on('error', rej);
  });
}

/**
 * コマンドをバックグラウンドで起動し、プロセスオブジェクトを返す。
 * detached で新しいプロセスグループを作り、停止時に pnpm 配下の子プロセス
 * (tsx や vite 本体) までまとめてシグナルを届けられるようにする。
 * @param cmd - 実行コマンド。
 * @param args - コマンド引数。
 * @param opts - spawn オプション。
 */
function runBg(cmd, args, opts = {}) {
  return spawn(cmd, args, { stdio: 'inherit', detached: true, ...opts });
}

/**
 * runBg で起動したプロセスをプロセスグループごと停止する。
 * pnpm ラッパーだけに SIGTERM を送ると tsx / vite 本体が生き残るため、
 * 負の pid でグループ全体にシグナルを送る。
 * @param proc - runBg が返した ChildProcess。
 * @param signal - 送るシグナル。
 */
function killGroup(proc, signal) {
  if (proc.pid === undefined) return;
  try {
    process.kill(-proc.pid, signal);
  } catch {
    // 既にグループごと終了している場合は無視する
  }
}

/**
 * 指定 URL に対して定期的に fetch を試み、200 応答が返るまで待つ。
 * @param url - 待機対象の URL。
 * @param timeoutMs - タイムアウト (ms)。既定 60 秒。
 */
async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // まだ起動していない
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

/**
 * ワークフロー run が終端ステータスになるまでポーリングで待つ。
 * @param runId - 監視する run の id。
 * @param timeoutMs - タイムアウト (ms)。既定 60 秒。
 */
async function waitForRunCompletion(runId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${SERVER_URL}/api/workflow-runs/${runId}`);
    if (!res.ok) throw new Error(`Failed to fetch run ${runId}: ${res.status}`);
    const run = await res.json();
    if (['success', 'partial', 'failed', 'aborted'].includes(run.status)) {
      return run.status;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Run ${runId} did not complete within ${timeoutMs}ms`);
}

async function main() {
  await mkdir(outDir, { recursive: true });

  // 一時 datasources.yaml を生成する (localhost:8090 の Trino を指す)。
  const tmpDir = join(tmpdir(), `hubble-workflow-screenshot-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
  const dsPath = join(tmpDir, 'datasources.yaml');
  await writeFile(
    dsPath,
    `datasources:\n  - id: trino-local\n    type: trino\n    displayName: Local Trino\n    username: admin\n    baseUrl: http://localhost:8090\n`,
    'utf8',
  );

  // サーバー起動 (packages/server を pnpm start で実行)。
  console.log('› サーバーを起動しています…');
  const serverProc = runBg('pnpm', ['--filter', '@hubble/server', 'start'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      DB_PATH: ':memory:',
      DATASOURCES_PATH: dsPath,
      DEFAULT_CATALOG: 'tpch',
      DEFAULT_SCHEMA: 'tiny',
    },
  });

  // web dev サーバー起動 (Vite の /api プロキシ先を SERVER_PORT に設定)。
  console.log('› web dev サーバーを起動しています…');
  const webProc = runBg('pnpm', ['--filter', '@hubble/web', 'dev'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
    },
  });

  let browser;
  try {
    // 両サーバーの起動を待つ。
    console.log('› サーバーの起動を待っています…');
    await Promise.all([
      waitForServer(`${SERVER_URL}/api/datasources`),
      waitForServer(`${BASE_URL}`),
    ]);
    console.log('› 両サーバーが起動しました。');

    // 既存ワークフローを全削除する。DB_PATH=:memory: なら通常は空だが、
    // 過去実行のサーバーが残留していた場合 (前回はこれで二重作成が起きた) でも
    // 一覧が 1 件だけの状態で撮影できるようにする。
    console.log('› 既存ワークフローを削除しています…');
    const listRes = await fetch(`${SERVER_URL}/api/workflows`);
    if (!listRes.ok) throw new Error(`ワークフロー一覧取得失敗 (${listRes.status})`);
    const existing = await listRes.json();
    for (const wf of existing) {
      const delRes = await fetch(`${SERVER_URL}/api/workflows/${wf.id}`, { method: 'DELETE' });
      if (!delRes.ok) throw new Error(`ワークフロー削除失敗 (${wf.id}): ${delRes.status}`);
      console.log(`›   削除: ${wf.id} (${wf.name})`);
    }

    // サンプルワークフローを API で作成する。
    console.log('› ワークフローを作成しています…');
    const createRes = await fetch(`${SERVER_URL}/api/workflows`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Daily sales report',
        description: 'Aggregate orders, then fan out to region/customer reports.',
        stages: [
          {
            steps: [
              {
                id: 'step-agg',
                name: 'Build daily aggregate',
                statement: 'SELECT count(*) AS orders FROM tpch.tiny.orders',
                catalog: 'tpch',
                schema: 'tiny',
                onFailure: 'stop',
              },
            ],
          },
          {
            steps: [
              {
                id: 'step-region',
                name: 'Sales by region',
                statement:
                  'SELECT r.name, count(*) AS cnt\nFROM tpch.tiny.nation n\nJOIN tpch.tiny.region r ON n.regionkey = r.regionkey\nGROUP BY r.name',
                catalog: 'tpch',
                schema: 'tiny',
                onFailure: 'continue',
              },
              {
                id: 'step-customers',
                name: 'Top customers',
                statement: 'SELECT name FROM tpch.tiny.customer ORDER BY acctbal DESC LIMIT 10',
                catalog: 'tpch',
                schema: 'tiny',
                onFailure: 'continue',
              },
            ],
          },
          {
            steps: [
              {
                id: 'step-notify',
                name: 'Notify',
                statement: 'SELECT 1',
                catalog: 'tpch',
                schema: 'tiny',
                onFailure: 'continue',
              },
            ],
          },
        ],
        enabled: true,
      }),
    });
    if (!createRes.ok) {
      const body = await createRes.text();
      throw new Error(`ワークフロー作成失敗 (${createRes.status}): ${body}`);
    }
    const workflow = await createRes.json();
    console.log(`› ワークフロー作成: id=${workflow.id}`);

    // ワークフローを実行する。
    console.log('› ワークフローを実行しています…');
    const runRes = await fetch(`${SERVER_URL}/api/workflows/${workflow.id}/run`, {
      method: 'POST',
    });
    if (!runRes.ok) {
      const body = await runRes.text();
      throw new Error(`ワークフロー実行失敗 (${runRes.status}): ${body}`);
    }
    const { runId } = await runRes.json();
    console.log(`› run 開始: runId=${runId}`);

    // run の完了を待つ。
    console.log('› run の完了を待っています…');
    const finalStatus = await waitForRunCompletion(runId);
    console.log(`› run 完了: status=${finalStatus}`);

    // Playwright でキャンバス画面を撮影する。
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const page = await context.newPage();

    // ライトテーマ、Workflows タブではなく Data タブで起動する。
    // 既に Workflows タブがアクティブだと、クリックでサイドバーが折りたたまれるため。
    await page.goto(BASE_URL, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      /* eslint-disable no-undef */
      document.documentElement.setAttribute('data-theme', 'light');
      window.localStorage.setItem(
        'hubble-ui',
        JSON.stringify({
          state: {
            theme: 'light',
            sidebarTab: 'data',
            sidebarWidth: 288,
            sidebarCollapsed: false,
          },
          version: 0,
        }),
      );
      /* eslint-enable no-undef */
    });
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(600);

    // レール上の Workflows ボタンをクリックしてパネルに切り替える。
    // 別タブから切り替えるためサイドバーは開いたままになる。
    const workflowsRailBtn = page.getByRole('button', { name: 'Workflows', exact: true }).first();
    await workflowsRailBtn.waitFor({ timeout: 10_000 });
    await workflowsRailBtn.click();
    await page.waitForTimeout(600);

    // ワークフロー行が表示されるのを待ち、クリックしてキャンバスを開く。
    // WorkflowsPanel の useWorkflows フックが /api/workflows を取得するまで待機する。
    console.log('› ワークフロー行をクリックしています…');
    const workflowRow = page.locator('button', { hasText: 'Daily sales report' }).first();
    await workflowRow.waitFor({ timeout: 20_000 });
    await workflowRow.click();
    await page.waitForTimeout(800);

    // キャンバス上にステップカードが描画されるのを待つ。
    // "Stage 1" の見出しが出れば WorkflowEditor がマウントされた証拠。
    await page.locator('text=Stage 1').first().waitFor({ timeout: 15_000 });

    // 最終 run のステータスバッジ (success) が表示されるまで待つ。
    await page.locator('text=success').first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(600);

    console.log('› スクリーンショットを撮影しています…');
    await page.screenshot({ path: resolve(outDir, 'workflow-canvas.png') });
    console.log(`✓ workflow-canvas.png を ${outDir} に保存しました。`);
  } finally {
    if (browser) await browser.close();

    // 起動したプロセスをプロセスグループごと確実に停止する。
    console.log('› プロセスを停止しています…');
    killGroup(serverProc, 'SIGTERM');
    killGroup(webProc, 'SIGTERM');

    // SIGTERM 後に少し待ち、子プロセスが終了する余裕を与える。
    await new Promise((r) => setTimeout(r, 1000));
    // 念のため SIGKILL も送る (既に終了していれば無視される)。
    killGroup(serverProc, 'SIGKILL');
    killGroup(webProc, 'SIGKILL');
    console.log('› プロセスを停止しました。');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

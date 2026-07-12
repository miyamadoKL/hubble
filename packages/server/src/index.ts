/**
 * hubble server のエントリーポイント（プロセス起動スクリプト）。
 *
 * 役割:
 * - 環境変数から `ServerConfig` を読み込み (`config.ts`)
 * - `app.ts` の `defaultServices` / `createApp` で Services グラフと Hono アプリを構築
 * - クエリスケジューラー (Query Scheduling 機能) を起動
 * - `@hono/node-server` で実際に HTTP リッスンを開始
 * - SIGINT/SIGTERM を受けて Trino クライアント、DB、スケジューラーを含む
 *   Services を安全にシャットダウンする
 *
 * アーキテクチャ上の位置づけ: このファイルのみが Node プロセスとして直接実行される。
 * `app.ts` の `createApp` はテスト (`app.test.ts` など) からも呼ばれるため、
 * プロセス起動固有の処理（listen、シグナルハンドリング、ログ出力）はここに閉じ込める。
 */
import { serve } from '@hono/node-server';
import { createApp, defaultServices } from './app';
import { loadServerConfig } from './config';
import { parseReloadIntervalSeconds, startFileReload } from './config/fileReload';
import { resolveDatasourcesPath } from './datasource/loader';
import { resolveRbacPath } from './rbac/loader';
import { staticDirExists } from './http/staticRoutes';
import { ShutdownCoordinator } from './shutdown/coordinator';

// 起動時に一度だけ環境変数から設定を読み込む（以後は不変な設定値として使い回す）。
const config = loadServerConfig();

// Report the selected persistence backend (DATABASE_URL vs DB_PATH) once at
// startup, without leaking credentials embedded in a connection string.
// 日本語: どちらの永続化バックエンドを使っているかを起動ログに残す。
// 接続文字列にパスワード等が含まれる postgres の場合は URL 自体を出力せず、
// 種別のみを表示することで認証情報の漏洩を防ぐ。
if (config.database.kind === 'postgres') {
  console.log('hubble persistence backend: postgres (DATABASE_URL)');
} else {
  console.log(`hubble persistence backend: sqlite (${config.database.path})`);
}

// Trino クライアント、DB 接続、各リポジトリなど、アプリ全体で共有する
// サービス群を構築する（services.ts の buildServices を参照）。DB マイグレーション
// もこの中で適用される。
const services = await defaultServices();

// datasources.yaml は必須化されているため、この時点で defaultServices() が既に
// 成功している(=ファイルが存在する)ことが保証されており、resolveDatasourcesPath は
// 必ず具体的なパスを返す。
const datasourcesPath = resolveDatasourcesPath(process.env, process.cwd());
const rbacPath = resolveRbacPath(process.env, process.cwd());
const reloadConfig = async (): Promise<void> => {
  await services.reloadConfig();
  fileReload.updateFiles(buildWatchedFiles());
};
const buildWatchedFiles = () =>
  [...new Set([rbacPath, datasourcesPath, ...services.datasourceDependencyFiles])].map((path) => ({
    path,
    reload: reloadConfig,
  }));
const intervalSeconds = parseReloadIntervalSeconds(process.env);
const fileReload = startFileReload(buildWatchedFiles(), { intervalSeconds });
if (intervalSeconds > 0) {
  console.log(`config hot-reload enabled (poll every ${intervalSeconds}s, SIGHUP)`);
} else {
  console.log('config hot-reload enabled (SIGHUP only)');
}

// 構築済み Services を注入して Hono アプリ（ルーティング一式）を組み立てる。
const app = createApp({ services });

// Start the in-process query scheduler (Query Scheduling feature). This performs
// crash recovery (aborting orphaned runs) and, unless SCHEDULER_ENABLED=false,
// starts the tick loop. The API is live regardless of the scheduler state.
// 日本語: サーバー内蔵の cron スケジューラーを起動する。起動時に「実行中のまま
// クラッシュした」run を異常終了扱いにするクラッシュリカバリを行い、
// SCHEDULER_ENABLED が false でない限り定期ティックループを開始する。
// スケジューラーが無効でも API 自体は通常通り応答する。
await services.scheduler.start();
await services.alertEvaluator.start();
await services.workflowRunner.start();
if (config.scheduler.enabled) {
  console.log(`hubble scheduler enabled (tick every ${config.scheduler.tickSeconds}s)`);
} else {
  console.log('hubble scheduler disabled (SCHEDULER_ENABLED=false)');
}

// STATIC_DIR が設定されているのに実際のディレクトリが存在しない場合、起動は
// 継続しつつ警告のみ出す（web ビルド忘れなどの運用ミスに気づけるようにする）。
if (config.staticDir && !staticDirExists(config.staticDir)) {
  console.warn(
    `STATIC_DIR is set to '${config.staticDir}' but that directory was not found. ` +
      'Build the web app (pnpm --filter web build) or unset STATIC_DIR.',
  );
}

// Node の HTTP サーバーを実際に起動する。Hono の fetch ハンドラをそのまま
// @hono/node-server に渡すことで、Node ランタイム上で Hono アプリを動かす。
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`hubble server listening on http://localhost:${info.port}`);
  if (config.staticDir) {
    console.log(`serving static web app from ${config.staticDir}`);
  }
});

// Graceful shutdown: スケジューラー停止と Trino/DB クローズ（services.shutdown）を
// 待ってから HTTP サーバーを閉じ、プロセスを正常終了させる。
// 日本語: 現在は先にHTTP受付とadmissionを止め、drainとHTTP closeの完了後に所有資源を閉じる。
let httpClosePromise: Promise<void> | undefined;
const beginHttpClose = (): Promise<void> => {
  if (httpClosePromise) return httpClosePromise;
  httpClosePromise = new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  return httpClosePromise;
};

const coordinator = new ShutdownCoordinator({
  timeoutMs: config.shutdownTimeoutMs,
  beginHttpClose,
  stopAdmission: services.stopAdmission,
  drain: async (context) => {
    const results = await Promise.allSettled([fileReload.stop(), services.drain(context)]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length > 0) throw new AggregateError(errors, 'Shutdown drain failed');
  },
  forceCloseHttp: () => {
    const closable = server as unknown as { closeAllConnections?: () => void };
    closable.closeAllConnections?.();
  },
  closeResources: services.closeResources,
});

let shutdownPromise: Promise<void> | undefined;
async function shutdown(): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    const result = await coordinator.shutdown();
    for (const failure of result.errors) {
      console.error(`shutdown phase '${failure.phase}' failed`, failure.error);
    }
    if (result.timedOut) {
      console.error(`shutdown exceeded ${config.shutdownTimeoutMs}ms; forcing process exit`);
      process.exit(1);
    }
    if (result.errors.length > 0) process.exitCode = 1;
  })();
  return shutdownPromise;
}

// コンテナ環境 (Docker/k8s) からの終了シグナルを拾い、リソースを解放してから終了する。
process.on('SIGINT', () => {
  void shutdown().catch((error: unknown) => {
    console.error('shutdown failed unexpectedly', error);
    process.exit(1);
  });
});
process.on('SIGTERM', () => {
  void shutdown().catch((error: unknown) => {
    console.error('shutdown failed unexpectedly', error);
    process.exit(1);
  });
});

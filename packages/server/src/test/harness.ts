import type { Hono } from 'hono';
import { openMemoryDatabase } from '../db';
import { loadServerConfig, type ServerConfig } from '../config';
import { buildServices, type Services } from '../services';
import { createApp } from '../app';
import type { AuthVariables, RemoteAddressFn } from '../auth/middleware';
import type { FakeScenario } from './fakeTrino';
import { FakeTrino } from './fakeTrino';

/**
 * server パッケージの結合テストで共通利用する「テストコンテキスト構築」を
 * 提供するファイル。インメモリ SQLite + `FakeTrino` (fakeTrino.ts) を使い、
 * 実際の DB/Trino を起動せずに `createApp()` で組み立てた完全な Hono アプリを
 * 得られるようにする。ルートハンドラの結合テスト (app.test.ts,
 * *Routes.test.ts 等) はほぼ全てこの `createTestContext` を起点にしている。
 */

/** `createTestContext` が返す、テストから触るための一式。 */
export interface TestContext {
  app: Hono<{ Variables: AuthVariables }>;
  services: Services;
  fake: FakeTrino;
}

/**
 * Build a fully-wired app backed by an in-memory SQLite db and a fake Trino.
 * Backoff sleeps resolve immediately so tests run fast.
 *
 * 日本語: 実施内容は次の通り。
 *   1. `options.scenarios` を積んだ `FakeTrino` を生成する (Trino の代わり)。
 *   2. `loadServerConfig` で既定設定を読み込み、`trino.baseUrl` を fake の URL に
 *      固定しつつ `options.configOverrides` で個別に上書きする。scheduler は
 *      デフォルトで tick ループを無効化する (`startScheduler` が true でない限り)
 *      ことで、ルート/CRUD テストが背後の非同期発火に影響されず決定的に動くようにする。
 *   3. インメモリ SQLite を開き、`buildServices` でサービス層一式を構築する。
 *      `fetchImpl` は fake.fetch (実ネットワークなしで応答)、`sleepImpl`/
 *      `schedulerSleep` は既定で即座に resolve するダミーにして、バックオフ待ちの
 *      せいでテストが遅くならないようにする。
 *   4. `services.scheduler.start()` を呼んでおく (クラッシュ復旧処理は常に必要。
 *      tick ループ自体は enabled=false なら回らない)。
 *   5. `createApp()` で Hono アプリを組み立てて返す。
 */
export async function createTestContext(
  options: {
    scenarios?: FakeScenario[];
    configOverrides?: Partial<ServerConfig>;
    env?: Record<string, string | undefined>;
    /** Override backoff sleep (e.g. to record requested delays). Defaults to a no-op. */
    sleepImpl?: (ms: number) => Promise<void>;
    /** Override the peer address the auth middleware sees (proxy-mode tests). */
    remoteAddress?: RemoteAddressFn;
    /** Start the in-process scheduler tick loop (default: false, API only). */
    startScheduler?: boolean;
    /** datasources.yaml 探索の作業ディレクトリ（テスト用）。 */
    cwd?: string;
  } = {},
): Promise<TestContext> {
  const fake = new FakeTrino(options.scenarios ?? []);
  const baseConfig = loadServerConfig(options.env ?? {});
  // 日本語: 各セクションごとにベース設定と configOverrides をマージする。
  // trino.baseUrl は常に fake サーバーの URL に固定した上で、
  // configOverrides.trino があればそれをさらに重ねて上書きできるようにする。
  const config: ServerConfig = {
    ...baseConfig,
    ...options.configOverrides,
    trino: { ...baseConfig.trino, baseUrl: 'http://trino.test', ...options.configOverrides?.trino },
    query: { ...baseConfig.query, ...options.configOverrides?.query },
    metadata: { ...baseConfig.metadata, ...options.configOverrides?.metadata },
    defaults: { ...baseConfig.defaults, ...options.configOverrides?.defaults },
    guard: { ...baseConfig.guard, ...options.configOverrides?.guard },
    scheduler: {
      ...baseConfig.scheduler,
      // Default: tick loop off so route/CRUD tests are deterministic.
      // 日本語: startScheduler を明示的に true にしない限り、スケジューラーの
      // tick タイマーは起動しない。これにより時間経過に依存しないテストになる。
      enabled: options.startScheduler ?? false,
      ...options.configOverrides?.scheduler,
    },
  };

  const db = await openMemoryDatabase();
  const services = await buildServices(config, db, {
    env: options.env,
    cwd: options.cwd,
    fetchImpl: fake.fetch,
    // 日本語: 既定では待たずに即 resolve するので、バックオフ待ちが原因で
    // テストが遅くなることはない。実際の待ち時間を検証したいテストのみ
    // sleepImpl を渡して記録し、制御する。
    sleepImpl: options.sleepImpl ?? (() => Promise.resolve()),
    schedulerSleep: () => Promise.resolve(),
  });
  // 日本語: enabled=false でもクラッシュ復旧 (abortOrphans) は必ず走るため、
  // tick ループを使わないテストでも start() は呼んでおく必要がある。
  await services.scheduler.start();
  const app = createApp({ services, remoteAddress: options.remoteAddress });
  return { app, services, fake };
}

/** Poll until a query reaches a terminal state (test convenience). */
// 日本語: registry から実行中のクエリを取得し、その `settled` プロミスを待つ
// だけのヘルパー。ストリーミング実行の完了 (成功/失敗/キャンセル問わず) を
// テストコードから簡潔に待ち合わせるために使う。該当クエリが既に registry から
// 消えている (見つからない) 場合は何もせずそのまま返る。
export async function waitForTerminal(services: Services, queryId: string): Promise<void> {
  const exec = services.registry.get(queryId);
  if (!exec) return;
  await exec.settled;
}

/**
 * サーバー全体で共有する長寿命サービス群（Services グラフ）の組み立てを担当するファイル。
 *
 * `app.ts` の `defaultServices()` や各テストハーネス（test/harness.ts）から
 * `buildServices(config, db, options)` が呼ばれ、Trino クライアント、メタデータ
 * サービス、クエリレジストリ/サービス、Query Guard 見積もりサービス、各 SQLite/
 * PostgreSQL リポジトリ、スケジューラーをすべて生成し、依存関係を配線したうえで
 * ひとつの `Services` オブジェクトとして返す。DI コンテナ的な役割を持つ、
 * アプリケーションの「配線の中心」。各ルーター (http/*Routes.ts) はこの
 * `Services` を受け取って処理を行う。
 */
import type { SqlDatabase } from './db/sqlDatabase';
import type { ServerConfig } from './config';
import { TrinoClient } from './trino/client';
import { MetadataSource } from './metadata/source';
import { MetadataService } from './metadata/service';
import { QueryRegistry } from './query/registry';
import { QueryService } from './query/service';
import { EstimateService } from './query/estimateService';
import { NotebookRepository } from './store/notebooks';
import { SavedQueryRepository } from './store/savedQueries';
import { HistoryRepository } from './store/history';
import { ScheduleRepository, ScheduleRunRepository } from './store/schedules';
import { StatementValidator } from './schedule/validator';
import { Scheduler } from './schedule/scheduler';
import { backfillOwners } from './db/backfill';

/** All long-lived services the HTTP layer depends on. */
/**
 * 日本語: HTTP 層（各 http/*Routes.ts）が依存する、アプリ全体で共有される
 * 長寿命サービス一式。`buildServices` がこの形に組み立てて返す。
 */
export interface Services {
  config: ServerConfig;
  trino: TrinoClient;
  metadata: MetadataService;
  queries: QueryService;
  registry: QueryRegistry;
  /** Query Guard scan-cost estimator (Query Guard feature). */
  estimate: EstimateService;
  notebooks: NotebookRepository;
  savedQueries: SavedQueryRepository;
  history: HistoryRepository;
  /** Schedule CRUD store (Query Scheduling feature). */
  schedules: ScheduleRepository;
  /** Schedule-run store (Query Scheduling feature). */
  scheduleRuns: ScheduleRunRepository;
  /** Statement validator (EXPLAIN VALIDATE) used by the schedule routes. */
  scheduleValidator: StatementValidator;
  /** In-process query scheduler (Query Scheduling feature). */
  scheduler: Scheduler;
  /** 日本語: プロセス終了時に呼ぶべき後片付け（スケジューラー停止、レジストリの
   * バックグラウンドタスク停止、DB クローズ）をまとめた関数。 */
  shutdown: () => Promise<void>;
}

/** 日本語: `buildServices` に渡す、テストで実運用の副作用（実ネットワーク I/O、
 * 実時間の待機、実クロック）を差し替えるためのオプション。本番経路では未指定
 * （= 実装のデフォルト動作）のまま使われる。 */
export interface BuildServicesOptions {
  /** Injectable fetch for tests (fake Trino). */
  fetchImpl?: typeof fetch;
  /** Injectable sleep for tests (deterministic backoff). */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable clock for tests (TTL/sweep). */
  now?: () => number;
  /** Injectable scheduler retry backoff sleep (tests). */
  schedulerSleep?: (ms: number) => Promise<void>;
  /** Injectable scheduler tick timer (tests). */
  schedulerSetTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

/** Construct the full service graph from config + an open database. */
/**
 * 日本語: 設定 (`ServerConfig`) と開いた DB 接続 (`SqlDatabase`) から、
 * サーバーが必要とするサービス一式を構築する。Trino クライアントを用途別
 * （ユーザークエリ用/メタデータ用/スケジュール実行用）に複数生成し、それぞれに
 * 異なる `X-Trino-Source` を付与することで、Trino 側で resource group を
 * ソース別に分離できるようにしている（design.md §3）。
 */
export async function buildServices(
  config: ServerConfig,
  db: SqlDatabase,
  options: BuildServicesOptions = {},
): Promise<Services> {
  // ユーザーが発行する通常クエリ用の Trino クライアント（X-Trino-Source: hubble）。
  const trino = new TrinoClient({
    baseUrl: config.trino.baseUrl,
    username: config.trino.username,
    password: config.trino.password,
    user: config.trino.user,
    source: config.trino.source,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });

  // メタデータ取得（カタログ/スキーマ/テーブル一覧等）専用のクライアント。
  // ソースを分けることで Trino 側の resource group をユーザークエリと分離できる。
  const metadataClient = new TrinoClient({
    baseUrl: config.trino.baseUrl,
    username: config.trino.username,
    password: config.trino.password,
    user: config.trino.user,
    source: config.trino.metadataSource,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });

  // Trino のシステムカタログ/information_schema をラップする取得層と、
  // その上に TTL キャッシュ + stale-while-revalidate を被せるサービス層。
  const metadataSource = new MetadataSource(metadataClient, config.trino.metadataSource);
  const metadata = new MetadataService(
    metadataSource,
    config.metadata.ttlSeconds * 1000,
    options.now,
  );

  // Backfill empty owners (from migration 0002) with the technical principal so
  // pre-existing rows become owned by the `none`-mode user (design.md §11).
  // 日本語: マイグレーション後にリポジトリを使い始める前に、owner が空文字のまま
  // 残っている既存行を技術 principal で埋めておく（各リポジトリの起動時初期化）。
  await backfillOwners(db, config.trino.user);

  // notebook / saved query / 実行履歴の永続化リポジトリ（SQLite/PostgreSQL 共通の
  // SqlDatabase インターフェース越しにアクセス）。
  const history = new HistoryRepository(db);
  const notebooks = new NotebookRepository(db);
  const savedQueries = new SavedQueryRepository(db);

  // 実行中クエリの状態（nextUri 追走、行バッファ、SSE 配信）を管理するレジストリ。
  const registry = new QueryRegistry({
    client: trino,
    defaultMaxRows: config.query.maxRows,
    concurrency: config.query.concurrency,
    ttlMs: config.query.ttlMinutes * 60_000,
    defaultOverflowMode: config.query.overflowMode,
    now: options.now,
  });

  const queries = new QueryService({ registry, history });

  // Query Guard estimator: runs EXPLAIN as the user's principal (impersonation
  // via the ctx.user override on the user client) but tagged with the metadata
  // source so guard EXPLAINs are distinguishable in Trino.
  const estimate = new EstimateService(
    trino,
    {
      mode: config.guard.mode,
      maxScanBytes: config.guard.maxScanBytes,
      maxScanRows: config.guard.maxScanRows,
      onUnknown: config.guard.onUnknown,
      estimateTimeoutMs: config.guard.estimateTimeoutMs,
      cacheTtlSeconds: config.guard.cacheTtlSeconds,
      bytesPerSecond: config.guard.bytesPerSecond,
    },
    config.trino.metadataSource,
    options.now,
  );

  // Query Scheduling: a dedicated client tagged with the scheduled source. The
  // per-run `X-Trino-User` is set from the schedule owner at execution time.
  const scheduledClient = new TrinoClient({
    baseUrl: config.trino.baseUrl,
    username: config.trino.username,
    password: config.trino.password,
    user: config.trino.user,
    source: config.trino.scheduledSource,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });

  const schedules = new ScheduleRepository(db);
  const scheduleRuns = new ScheduleRunRepository(db, config.scheduler.runsRetention);
  const scheduleValidator = new StatementValidator(scheduledClient, config.trino.scheduledSource);
  const scheduler = new Scheduler({
    schedules,
    runs: scheduleRuns,
    client: scheduledClient,
    validator: scheduleValidator,
    estimate,
    config: {
      enabled: config.scheduler.enabled,
      tickSeconds: config.scheduler.tickSeconds,
      maxConcurrent: config.scheduler.maxConcurrent,
      runsRetention: config.scheduler.runsRetention,
      guardMode: config.guard.mode,
    },
    source: config.trino.scheduledSource,
    now: options.now,
    sleep: options.schedulerSleep,
    setTimer: options.schedulerSetTimer,
  });

  return {
    config,
    trino,
    metadata,
    queries,
    registry,
    estimate,
    notebooks,
    savedQueries,
    history,
    schedules,
    scheduleRuns,
    scheduleValidator,
    scheduler,
    shutdown: async () => {
      await scheduler.stop();
      await registry.shutdown();
      await db.close();
    },
  };
}

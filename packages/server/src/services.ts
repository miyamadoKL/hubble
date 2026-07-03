/**
 * サーバー全体で共有する長寿命サービス群（Services グラフ）の組み立てを担当するファイル。
 *
 * `app.ts` の `defaultServices()` や各テストハーネス（test/harness.ts）から
 * `buildServices(config, db, options)` が呼ばれ、QueryEngine、メタデータ
 * サービス、クエリレジストリ/サービス、Query Guard 見積もりサービス、各 SQLite/
 * PostgreSQL リポジトリ、スケジューラーをすべて生成し、依存関係を配線したうえで
 * ひとつの `Services` オブジェクトとして返す。
 */
import type { SqlDatabase } from './db/sqlDatabase';
import type { ServerConfig } from './config';
import { MetadataService } from './metadata/service';
import { QueryRegistry } from './query/registry';
import { QueryService } from './query/service';
import { EstimateService } from './query/estimateService';
import { NotebookRepository } from './store/notebooks';
import { SavedQueryRepository } from './store/savedQueries';
import { HistoryRepository } from './store/history';
import { ScheduleRepository, ScheduleRunRepository } from './store/schedules';
import { Scheduler } from './schedule/scheduler';
import { backfillOwners } from './db/backfill';
import { loadDatasources } from './datasource/loader';
import type { ResolvedDatasource } from './datasource/types';
import { buildEngines } from './engine/factory';
import type { QueryEngine } from './engine/types';

/** All long-lived services the HTTP layer depends on. */
export interface Services {
  config: ServerConfig;
  /** 宣言的に設定されたデータソース一覧。 */
  datasources: ResolvedDatasource[];
  /** データソース id から引ける QueryEngine マップ。 */
  engines: Map<string, QueryEngine>;
  /** datasourceId 省略時に使う既定 id（設定順先頭）。 */
  defaultDatasourceId: string;
  metadata: MetadataService;
  queries: QueryService;
  registry: QueryRegistry;
  estimate: EstimateService;
  notebooks: NotebookRepository;
  savedQueries: SavedQueryRepository;
  history: HistoryRepository;
  schedules: ScheduleRepository;
  scheduleRuns: ScheduleRunRepository;
  scheduler: Scheduler;
  shutdown: () => Promise<void>;
}

export interface BuildServicesOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  now?: () => number;
  schedulerSleep?: (ms: number) => Promise<void>;
  schedulerSetTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

/**
 * 日本語: 設定 (`ServerConfig`) と開いた DB 接続 (`SqlDatabase`) から、
 * サーバーが必要とするサービス一式を構築する。
 */
export async function buildServices(
  config: ServerConfig,
  db: SqlDatabase,
  options: BuildServicesOptions = {},
): Promise<Services> {
  const env = options.env ?? process.env;
  const datasources = loadDatasources({ env, trino: config.trino, cwd: options.cwd });
  const { engines, defaultDatasourceId } = buildEngines(datasources, {
    trinoConfig: config.trino,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
    now: options.now,
  });

  const metadata = new MetadataService(
    engines,
    defaultDatasourceId,
    config.metadata.ttlSeconds * 1000,
    options.now,
  );

  await backfillOwners(db, config.trino.user);

  const history = new HistoryRepository(db);
  const notebooks = new NotebookRepository(db);
  const savedQueries = new SavedQueryRepository(db);

  const registry = new QueryRegistry({
    engines,
    defaultDatasourceId,
    defaultMaxRows: config.query.maxRows,
    concurrency: config.query.concurrency,
    ttlMs: config.query.ttlMinutes * 60_000,
    defaultOverflowMode: config.query.overflowMode,
    now: options.now,
  });

  const queries = new QueryService({ registry, history });

  const estimate = new EstimateService(
    engines,
    defaultDatasourceId,
    {
      mode: config.guard.mode,
      maxScanBytes: config.guard.maxScanBytes,
      maxScanRows: config.guard.maxScanRows,
      onUnknown: config.guard.onUnknown,
      estimateTimeoutMs: config.guard.estimateTimeoutMs,
      cacheTtlSeconds: config.guard.cacheTtlSeconds,
      bytesPerSecond: config.guard.bytesPerSecond,
    },
    options.now,
  );

  const schedules = new ScheduleRepository(db);
  const scheduleRuns = new ScheduleRunRepository(db, config.scheduler.runsRetention);
  const scheduler = new Scheduler({
    schedules,
    runs: scheduleRuns,
    engines,
    defaultDatasourceId,
    estimate,
    config: {
      enabled: config.scheduler.enabled,
      tickSeconds: config.scheduler.tickSeconds,
      maxConcurrent: config.scheduler.maxConcurrent,
      runsRetention: config.scheduler.runsRetention,
      guardMode: config.guard.mode,
    },
    now: options.now,
    sleep: options.schedulerSleep,
    setTimer: options.schedulerSetTimer,
  });

  return {
    config,
    datasources,
    engines,
    defaultDatasourceId,
    metadata,
    queries,
    registry,
    estimate,
    notebooks,
    savedQueries,
    history,
    schedules,
    scheduleRuns,
    scheduler,
    shutdown: async () => {
      await scheduler.stop();
      await registry.shutdown();
      await db.close();
    },
  };
}

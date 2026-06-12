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
  shutdown: () => Promise<void>;
}

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
export async function buildServices(
  config: ServerConfig,
  db: SqlDatabase,
  options: BuildServicesOptions = {},
): Promise<Services> {
  const trino = new TrinoClient({
    baseUrl: config.trino.baseUrl,
    username: config.trino.username,
    password: config.trino.password,
    user: config.trino.user,
    source: config.trino.source,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });

  const metadataClient = new TrinoClient({
    baseUrl: config.trino.baseUrl,
    username: config.trino.username,
    password: config.trino.password,
    user: config.trino.user,
    source: config.trino.metadataSource,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
  });

  const metadataSource = new MetadataSource(metadataClient, config.trino.metadataSource);
  const metadata = new MetadataService(
    metadataSource,
    config.metadata.ttlSeconds * 1000,
    options.now,
  );

  // Backfill empty owners (from migration 0002) with the technical principal so
  // pre-existing rows become owned by the `none`-mode user (design.md §11).
  await backfillOwners(db, config.trino.user);

  const history = new HistoryRepository(db);
  const notebooks = new NotebookRepository(db);
  const savedQueries = new SavedQueryRepository(db);

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

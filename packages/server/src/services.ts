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
import { DocumentShareRepository } from './store/documentShares';
import { HistoryRepository } from './store/history';
import { ScheduleRepository, ScheduleRunRepository } from './store/schedules';
import { WorkflowRepository, WorkflowRunRepository } from './store/workflows';
import { Scheduler } from './schedule/scheduler';
import { WorkflowRunner } from './workflow/runner';
import { backfillOwners } from './db/backfill';
import { loadDatasources } from './datasource/loader';
import { loadRbac } from './rbac/loader';
import type { LoadedRbac } from './rbac/types';
import type { ResolvedDatasource } from './datasource/types';
import { applyDatasourceReloadSync, planDatasourceReload } from './datasource/reload';
import { buildEngines, type BuildEnginesOptions } from './engine/factory';
import type { MysqlPoolFactory } from './engine/mysql/pool';
import type { PgPoolFactory } from './engine/postgresql/pool';
import type { QueryEngine } from './engine/types';
import { AuditLogger, AuditRepository } from './audit';
import { createResultStore, type ResultStore } from './resultStore';
import { ResultExpiryService } from './resultStore/cleanup';
import { NotificationService } from './notification/service';
import type { FailureNotificationSender } from './notification/service';

export interface Services {
  config: ServerConfig;
  rbac: LoadedRbac;
  datasources: ResolvedDatasource[];
  engines: Map<string, QueryEngine>;
  defaultDatasourceId: string;
  metadata: MetadataService;
  queries: QueryService;
  registry: QueryRegistry;
  estimate: EstimateService;
  notebooks: NotebookRepository;
  savedQueries: SavedQueryRepository;
  documentShares: DocumentShareRepository;
  history: HistoryRepository;
  schedules: ScheduleRepository;
  scheduleRuns: ScheduleRunRepository;
  scheduler: Scheduler;
  workflows: WorkflowRepository;
  workflowRuns: WorkflowRunRepository;
  workflowRunner: WorkflowRunner;
  audit: AuditLogger;
  resultStore: ResultStore;
  resultExpiry: ResultExpiryService;
  notifications: FailureNotificationSender;
  reloadDatasources: () => Promise<void>;
  reloadRbac: () => Promise<void>;
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
  workflowRunnerSleep?: (ms: number) => Promise<void>;
  workflowRunnerSetTimer?: (fn: () => void, ms: number) => { clear: () => void };
  mysqlPoolFactory?: MysqlPoolFactory;
  pgPoolFactory?: PgPoolFactory;
  reloadLogError?: (message: string, err: unknown) => void;
  reloadLogWarn?: (message: string) => void;
  auditLogError?: (message: string, err: unknown) => void;
  resultStore?: ResultStore;
  resultStoreLogWarn?: (message: string, err?: unknown) => void;
  resultCleanupSetTimer?: (fn: () => void, ms: number) => { clear: () => void };
  notificationLogWarn?: (message: string, detail?: unknown) => void;
  notificationSender?: FailureNotificationSender;
}

export async function buildServices(
  config: ServerConfig,
  db: SqlDatabase,
  options: BuildServicesOptions = {},
): Promise<Services> {
  const env = options.env ?? process.env;
  const cwd = options.cwd;
  const rbacState = { current: loadRbac({ env, cwd }) };
  const datasources = loadDatasources({ env, cwd });
  const buildEngineOptions: BuildEnginesOptions = {
    trinoConfig: config.trino,
    fetchImpl: options.fetchImpl,
    sleepImpl: options.sleepImpl,
    now: options.now,
    mysqlPoolFactory: options.mysqlPoolFactory,
    pgPoolFactory: options.pgPoolFactory,
  };
  const built = buildEngines(datasources, buildEngineOptions);
  const { engines } = built;
  const runtime = { defaultDatasourceId: built.defaultDatasourceId };

  const metadata = new MetadataService(
    engines,
    runtime.defaultDatasourceId,
    config.metadata.ttlSeconds * 1000,
    options.now,
  );
  await backfillOwners(db, config.trino.user);

  const audit = new AuditLogger(new AuditRepository(db), options.auditLogError);
  const resultStore = options.resultStore ?? createResultStore(config.resultStore);
  const notifications =
    options.notificationSender ??
    new NotificationService(config.notification, {
      fetchImpl: options.fetchImpl,
      audit,
      logWarn: options.notificationLogWarn,
    });
  const history = new HistoryRepository(db);
  const documentShares = new DocumentShareRepository(db);
  const notebooks = new NotebookRepository(db, documentShares);
  const savedQueries = new SavedQueryRepository(db, documentShares);
  const registry = new QueryRegistry({
    engines,
    defaultDatasourceId: runtime.defaultDatasourceId,
    defaultMaxRows: config.query.maxRows,
    concurrency: config.query.concurrency,
    ttlMs: config.query.ttlMinutes * 60_000,
    defaultOverflowMode: config.query.overflowMode,
    now: options.now,
  });
  const queries = new QueryService({
    registry,
    history,
    resultStore,
    resultKeyPrefix:
      config.resultStore.kind === 's3' ? config.resultStore.prefix : 'hubble-results/',
    resultTtlDays: config.resultStore.ttlDays,
    audit,
    logWarn: options.resultStoreLogWarn,
    now: options.now,
  });
  const estimate = new EstimateService(
    engines,
    runtime.defaultDatasourceId,
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
  const workflows = new WorkflowRepository(db);
  const workflowRuns = new WorkflowRunRepository(db, config.scheduler.runsRetention);
  const scheduler = new Scheduler({
    schedules,
    runs: scheduleRuns,
    engines,
    defaultDatasourceId: runtime.defaultDatasourceId,
    estimate,
    getRbac: () => rbacState.current,
    guardConfig: config.guard,
    audit,
    notifications,
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
  const workflowRunner = new WorkflowRunner({
    workflows,
    runs: workflowRuns,
    engines,
    defaultDatasourceId: runtime.defaultDatasourceId,
    estimate,
    getRbac: () => rbacState.current,
    guardConfig: config.guard,
    audit,
    resultStore,
    resultKeyPrefix:
      config.resultStore.kind === 's3' ? config.resultStore.prefix : 'hubble-results/',
    resultTtlDays: config.resultStore.ttlDays,
    config: {
      enabled: config.scheduler.enabled,
      tickSeconds: config.scheduler.tickSeconds,
      maxConcurrent: config.scheduler.maxConcurrent,
      runsRetention: config.scheduler.runsRetention,
      guardMode: config.guard.mode,
    },
    now: options.now,
    sleep: options.workflowRunnerSleep ?? options.schedulerSleep,
    setTimer: options.workflowRunnerSetTimer ?? options.schedulerSetTimer,
  });
  const resultExpiry = new ResultExpiryService({
    history,
    workflowRuns,
    resultStore,
    now: options.now,
    logWarn: options.resultStoreLogWarn,
    setTimer: options.resultCleanupSetTimer,
  });
  resultExpiry.start();

  let reloadInFlight = false;
  let rbacReloadInFlight = false;
  const reloadLogError = options.reloadLogError ?? ((m, e) => console.error(m, e));
  const reloadLogWarn = options.reloadLogWarn ?? console.warn;
  const reloadRbac = async (): Promise<void> => {
    if (rbacReloadInFlight) return;
    rbacReloadInFlight = true;
    try {
      rbacState.current = loadRbac({ env, cwd });
    } catch (err) {
      reloadLogError('rbac reload failed; keeping current config', err);
    } finally {
      rbacReloadInFlight = false;
    }
  };
  const reloadDatasources = async (): Promise<void> => {
    if (reloadInFlight) return;
    reloadInFlight = true;
    try {
      const next = loadDatasources({ env, cwd });
      const plan = planDatasourceReload(engines, datasources, next, buildEngineOptions);
      applyDatasourceReloadSync(
        {
          engines,
          datasources,
          setDefaultDatasourceId: (id) => {
            runtime.defaultDatasourceId = id;
            metadata.setDefaultDatasourceId(id);
            registry.setDefaultDatasourceId(id);
            estimate.setDefaultDatasourceId(id);
            scheduler.setDefaultDatasourceId(id);
            workflowRunner.setDefaultDatasourceId(id);
          },
          invalidateDatasource: (id) => {
            metadata.invalidateDatasource(id);
            estimate.invalidateDatasource(id);
          },
        },
        plan,
        reloadLogWarn,
      );
    } catch (err) {
      reloadLogError('datasource reload failed; keeping current config', err);
    } finally {
      reloadInFlight = false;
    }
  };

  return {
    config,
    get rbac() {
      return rbacState.current;
    },
    datasources,
    engines,
    get defaultDatasourceId() {
      return runtime.defaultDatasourceId;
    },
    metadata,
    queries,
    registry,
    estimate,
    notebooks,
    savedQueries,
    documentShares,
    history,
    schedules,
    scheduleRuns,
    scheduler,
    workflows,
    workflowRuns,
    workflowRunner,
    audit,
    resultStore,
    resultExpiry,
    notifications,
    reloadDatasources,
    reloadRbac,
    shutdown: async () => {
      resultExpiry.stop();
      await workflowRunner.stop();
      await scheduler.stop();
      await registry.shutdown();
      await db.close();
    },
  };
}

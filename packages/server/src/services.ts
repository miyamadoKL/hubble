/**
 * サーバー全体で共有する長寿命サービス群（Services グラフ）の組み立てを担当するファイル。
 *
 * `app.ts` の `defaultServices()` や各テストハーネス（test/harness.ts）から
 * `buildServices(config, db, options)` が呼ばれ、QueryEngine、メタデータ
 * サービス、クエリレジストリ/サービス、Query Guard 見積もりサービス、各 SQLite/
 * PostgreSQL リポジトリ、スケジューラーをすべて生成し、依存関係を配線したうえで
 * ひとつの `Services` オブジェクトとして返す。
 */
import { existsSync } from 'node:fs';
import type { SqlDatabase } from './db/sqlDatabase';
import type { ServerConfig } from './config';
import { MetadataService } from './metadata/service';
import { QueryRegistry } from './query/registry';
import { QueryService } from './query/service';
import { EstimateService } from './query/estimateService';
import { NotebookRepository } from './store/notebooks';
import { DashboardRepository } from './store/dashboards';
import { SavedQueryRepository } from './store/savedQueries';
import { DocumentShareRepository } from './store/documentShares';
import { HistoryRepository } from './store/history';
import { ScheduleRepository, ScheduleRunRepository } from './store/schedules';
import { AlertRepository } from './store/alerts';
import { AlertDeliveryRepository } from './store/alertDeliveries';
import { ResultObjectDeletionRepository } from './store/resultObjectDeletions';
import { WorkflowRepository, WorkflowRunRepository } from './store/workflows';
import { Scheduler } from './schedule/scheduler';
import { AlertEvaluator } from './alert/evaluator';
import { WorkflowRunner } from './workflow/runner';
import { backfillOwners } from './db/backfill';
import { loadDatasources } from './datasource/loader';
import { loadRbac, resolveRbacPath } from './rbac/loader';
import type { LoadedRbac } from './rbac/types';
import type { ResolvedDatasource } from './datasource/types';
import {
  applyDatasourceReloadSync,
  closeCandidateEngines,
  planDatasourceReload,
  probeCandidateEngines,
  type DatasourceReloadPlan,
} from './datasource/reload';
import { buildEngines, type BuildEnginesOptions } from './engine/factory';
import type { MysqlPoolFactory } from './engine/mysql/pool';
import type { PgPoolFactory } from './engine/postgresql/pool';
import type { QueryEngine } from './engine/types';
import { AuditLogger, AuditRepository } from './audit';
import { createResultStore, type ResultStore } from './resultStore';
import { ResultExpiryService } from './resultStore/cleanup';
import { NotificationService } from './notification/service';
import type {
  FailureNotificationSender,
  AlertNotificationSender,
  AlertChannelNotificationSender,
} from './notification/service';
import { AlertDeliveryWorker } from './alert/deliveryWorker';
import { GithubApiClient } from './github/client';
import { GithubConnectionRepository, DocumentGitLinkRepository } from './github/store';
import { GithubSyncService } from './github/syncService';
import { GithubGovernanceService } from './github/governance';
import { GithubSyncScheduler } from './github/syncScheduler';
import { createAiProvider, type AiProvider } from './ai/provider';
import { AiService } from './ai/service';
import { AiRateLimiter } from './ai/rateLimiter';
import { JobAdmissionController } from './schedule/admission';
import type { ShutdownDrainContext } from './shutdown/coordinator';

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
  dashboards: DashboardRepository;
  savedQueries: SavedQueryRepository;
  documentShares: DocumentShareRepository;
  history: HistoryRepository;
  schedules: ScheduleRepository;
  scheduleRuns: ScheduleRunRepository;
  scheduler: Scheduler;
  alerts: AlertRepository;
  alertEvaluator: AlertEvaluator;
  alertDeliveries: AlertDeliveryRepository;
  alertDeliveryWorker: AlertDeliveryWorker;
  workflows: WorkflowRepository;
  workflowRuns: WorkflowRunRepository;
  workflowRunner: WorkflowRunner;
  audit: AuditLogger;
  resultStore: ResultStore;
  resultExpiry: ResultExpiryService;
  notifications: FailureNotificationSender &
    AlertNotificationSender &
    AlertChannelNotificationSender;
  github?: GithubSyncService;
  githubSyncScheduler?: GithubSyncScheduler;
  githubGovernance: GithubGovernanceService;
  /** AI アシスタント。provider が off のときは undefined。 */
  ai?: AiService;
  /** AI アシスタントのプロセス共有利用枠。provider が off のときは undefined。 */
  aiRateLimiter?: AiRateLimiter;
  /** GitHub OAuth state 生成用の now 注入 (テスト用)。 */
  githubNow?: () => number;
  reloadDatasources: () => Promise<void>;
  reloadRbac: () => Promise<void>;
  reloadConfig: () => Promise<void>;
  /** 現在公開中のデータソース世代が参照する secret file。 */
  readonly datasourceDependencyFiles: readonly string[];
  /** query と手動jobの新規受付を同期的に止める。 */
  stopAdmission: () => void;
  /** worker、query、非同期永続化を期限までdrainする。 */
  drain: (context: ShutdownDrainContext) => Promise<void>;
  /** engine、ResultStore、通知、DBを一件の失敗で中断せずcloseする。 */
  closeResources: () => Promise<void>;
  /** HTTP serverを持たないテストなどで使う一括停止。 */
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
  alertEvaluatorSetTimer?: (fn: () => void, ms: number) => { clear: () => void };
  alertDeliverySetTimer?: (fn: () => void, ms: number) => { clear: () => void };
  workflowRunnerSleep?: (ms: number) => Promise<void>;
  workflowRunnerSetTimer?: (fn: () => void, ms: number) => { clear: () => void };
  mysqlPoolFactory?: MysqlPoolFactory;
  pgPoolFactory?: PgPoolFactory;
  reloadLogError?: (message: string, err: unknown) => void;
  reloadLogWarn?: (message: string) => void;
  auditLogError?: (message: string, err: unknown) => void;
  /** 注入した ResultStore の所有権は Services へ移り、shutdown時にcloseされる。 */
  resultStore?: ResultStore;
  resultStoreLogWarn?: (message: string, err?: unknown) => void;
  resultCleanupSetTimer?: (fn: () => void, ms: number) => { clear: () => void };
  notificationLogWarn?: (message: string, detail?: unknown) => void;
  notificationSender?: FailureNotificationSender &
    AlertNotificationSender &
    AlertChannelNotificationSender;
  githubClient?: import('./github/client').GithubClient;
  githubSyncSetTimer?: (fn: () => void, ms: number) => { clear: () => void };
  /** テスト注入用の AI provider。 */
  aiProvider?: AiProvider;
}

export async function buildServices(
  config: ServerConfig,
  db: SqlDatabase,
  options: BuildServicesOptions = {},
): Promise<Services> {
  const env = options.env ?? process.env;
  const cwd = options.cwd;
  const rbacState = { current: loadRbac({ env, cwd }) };
  const rbacPath = resolveRbacPath(env, cwd ?? process.cwd());
  const hasExplicitRbacPath = env.RBAC_PATH !== undefined && env.RBAC_PATH !== '';
  let rbacFileRequired = hasExplicitRbacPath || existsSync(rbacPath);
  let datasourceDependencyFiles = new Set<string>();
  const datasources = loadDatasources({ env, cwd, dependencyFiles: datasourceDependencyFiles });
  const buildEngineOptions: BuildEnginesOptions = {
    trinoConfig: config.trino,
    operationTimeoutMs: config.guard.estimateTimeoutMs,
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
  const aiProvider = options.aiProvider ?? createAiProvider(config.ai, options.fetchImpl);
  const aiLimits =
    config.ai.provider === 'off'
      ? {
          maxConcurrency: 4,
          perPrincipalPerMinute: 20,
          maxResponseBytes: 262_144,
        }
      : config.ai;
  const ai =
    aiProvider === undefined
      ? undefined
      : new AiService({
          provider: aiProvider,
          audit,
          timeoutMs: config.ai.provider === 'off' ? 60_000 : config.ai.timeoutMs,
          maxResponseBytes: aiLimits.maxResponseBytes,
        });
  const aiRateLimiter =
    aiProvider === undefined
      ? undefined
      : new AiRateLimiter({
          maxConcurrency: aiLimits.maxConcurrency,
          perPrincipalPerMinute: aiLimits.perPrincipalPerMinute,
          now: options.now,
        });
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
  const dashboards = new DashboardRepository(db, documentShares);
  const savedQueries = new SavedQueryRepository(db, documentShares);
  const registry = new QueryRegistry({
    engines,
    defaultDatasourceId: runtime.defaultDatasourceId,
    defaultMaxRows: config.query.maxRows,
    concurrency: config.query.concurrency,
    maxQueued: config.query.maxQueued,
    maxQueuedPerPrincipal: config.query.maxQueuedPerPrincipal,
    maxTracked: config.query.maxTracked,
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
  const alerts = new AlertRepository(db);
  const alertDeliveries = new AlertDeliveryRepository(db);
  const resultObjectDeletions = new ResultObjectDeletionRepository(db);
  const workflows = new WorkflowRepository(db);
  const workflowRuns = new WorkflowRunRepository(db, config.scheduler.runsRetention);
  const documentGitLinks = new DocumentGitLinkRepository(db);
  const jobAdmission = new JobAdmissionController(config.scheduler.maxConcurrent);
  const githubGovernance = new GithubGovernanceService({
    config: config.github,
    links: documentGitLinks,
    savedQueries,
    notebooks,
    workflows,
    now: options.now,
  });
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
    admission: jobAdmission,
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
  const alertEvaluator = new AlertEvaluator({
    db,
    alerts,
    savedQueries,
    engines,
    defaultDatasourceId: runtime.defaultDatasourceId,
    estimate,
    getRbac: () => rbacState.current,
    guardConfig: config.guard,
    audit,
    admission: jobAdmission,
    config: {
      enabled: config.scheduler.enabled,
      tickSeconds: config.scheduler.tickSeconds,
      maxConcurrent: config.scheduler.maxConcurrent,
      guardMode: config.guard.mode,
    },
    now: options.now,
    setTimer: options.alertEvaluatorSetTimer ?? options.schedulerSetTimer,
  });
  const alertDeliveryWorker = new AlertDeliveryWorker({
    deliveries: alertDeliveries,
    notifications,
    config: config.alertDelivery,
    now: options.now,
    setTimer: options.alertDeliverySetTimer,
    logWarn: options.notificationLogWarn,
  });
  alertDeliveryWorker.start();
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
    githubGovernance,
    admission: jobAdmission,
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
    deletions: resultObjectDeletions,
    resultStore,
    now: options.now,
    logWarn: options.resultStoreLogWarn,
    setTimer: options.resultCleanupSetTimer,
  });
  resultExpiry.start();

  const githubNow = options.now ?? (() => Date.now());
  let github: GithubSyncService | undefined;
  let githubSyncScheduler: GithubSyncScheduler | undefined;
  if (config.github.enabled) {
    const githubClient = new GithubApiClient({
      clientId: config.github.clientId!,
      clientSecret: config.github.clientSecret!,
      fetchImpl: options.fetchImpl,
    });
    const githubConnections = new GithubConnectionRepository(db);
    github = new GithubSyncService({
      db,
      config: config.github,
      client: options.githubClient ?? githubClient,
      connections: githubConnections,
      links: documentGitLinks,
      savedQueries,
      notebooks,
      dashboards,
      workflows,
      alerts,
      audit,
      encryptionKey: config.github.tokenEncryptionKey!,
      getRbac: () => rbacState.current,
      now: githubNow,
    });
    githubSyncScheduler = new GithubSyncScheduler({
      syncService: github,
      syncCron: config.github.syncCron,
      now: githubNow,
      setTimer: options.githubSyncSetTimer,
    });
    githubSyncScheduler.start();
  }

  let reloadInFlight = false;
  let rbacReloadInFlight = false;
  let configReloadInFlight = false;
  const reloadLogError = options.reloadLogError ?? ((m, e) => console.error(m, e));
  const reloadLogWarn = options.reloadLogWarn ?? console.warn;
  const applyDatasourcePlan = (plan: DatasourceReloadPlan): void => {
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
          alertEvaluator.setDefaultDatasourceId(id);
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
  };
  const reloadRbac = async (): Promise<void> => {
    if (rbacReloadInFlight) return;
    rbacReloadInFlight = true;
    try {
      const defaultFileExists = existsSync(rbacPath);
      const next = loadRbac({
        env,
        cwd,
        allowMissingDefault: !rbacFileRequired && !defaultFileExists,
      });
      rbacState.current = next;
      if (defaultFileExists || existsSync(rbacPath)) rbacFileRequired = true;
    } catch (err) {
      reloadLogError('rbac reload failed; keeping current config', err);
    } finally {
      rbacReloadInFlight = false;
    }
  };
  const reloadDatasources = async (): Promise<void> => {
    if (reloadInFlight) return;
    reloadInFlight = true;
    let plan: DatasourceReloadPlan | undefined;
    try {
      const nextDependencyFiles = new Set<string>();
      const next = loadDatasources({ env, cwd, dependencyFiles: nextDependencyFiles });
      plan = planDatasourceReload(engines, datasources, next, buildEngineOptions);
      await probeCandidateEngines(plan, config.datasourceProbeTimeoutMs);
      applyDatasourcePlan(plan);
      datasourceDependencyFiles = nextDependencyFiles;
      plan = undefined;
    } catch (err) {
      if (plan) closeCandidateEngines(plan, reloadLogWarn);
      reloadLogError('datasource reload failed; keeping current config', err);
    } finally {
      reloadInFlight = false;
    }
  };
  const reloadConfig = async (): Promise<void> => {
    if (configReloadInFlight) return;
    configReloadInFlight = true;
    let plan: DatasourceReloadPlan | undefined;
    try {
      // 同じ watcher turn の二つ目の呼び出しが in-flight を観測できるよう一度譲る。
      await Promise.resolve();
      const defaultFileExists = existsSync(rbacPath);
      const rbacNext = loadRbac({
        env,
        cwd,
        allowMissingDefault: !rbacFileRequired && !defaultFileExists,
      });
      const requireRbacFile = rbacFileRequired || defaultFileExists || existsSync(rbacPath);
      const nextDependencyFiles = new Set<string>();
      const datasourceNext = loadDatasources({
        env,
        cwd,
        dependencyFiles: nextDependencyFiles,
      });
      plan = planDatasourceReload(engines, datasources, datasourceNext, buildEngineOptions);
      await probeCandidateEngines(plan, config.datasourceProbeTimeoutMs);

      // 疎通確認済みの候補だけを同一 turn で両設定へ公開する。
      applyDatasourcePlan(plan);
      rbacState.current = rbacNext;
      rbacFileRequired = requireRbacFile;
      datasourceDependencyFiles = nextDependencyFiles;
      plan = undefined;
    } catch (err) {
      if (plan) closeCandidateEngines(plan, reloadLogWarn);
      reloadLogError('config reload failed; keeping current config', err);
    } finally {
      configReloadInFlight = false;
    }
  };

  let drainPromise: Promise<void> | undefined;
  let closeResourcesPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  const stopAdmission = (): void => {
    registry.stopAccepting();
    jobAdmission.stopAccepting();
  };
  const drain = (context: ShutdownDrainContext): Promise<void> => {
    if (drainPromise) return drainPromise;
    stopAdmission();
    const tasks: Promise<unknown>[] = [
      resultExpiry.stop(),
      githubSyncScheduler?.stop() ?? Promise.resolve(),
      workflowRunner.stop(),
      alertEvaluator.stop(),
      alertDeliveryWorker.stop(),
      scheduler.stop(),
      registry.shutdown({ deadlineAt: context.deadlineAt }).then((result) => {
        if (result.timedOut) throw new Error('Query registry drain timed out');
      }),
      jobAdmission.whenIdle(),
      queries.drain(),
    ];
    drainPromise = settleServiceTasks(tasks, context, 'Service drain');
    return drainPromise;
  };
  const closeResources = (): Promise<void> => {
    if (closeResourcesPromise) return closeResourcesPromise;
    closeResourcesPromise = (async () => {
      const errors: unknown[] = [];
      const enginesToClose = [...new Set(engines.values())];
      const ownedNotifications =
        options.notificationSender === undefined
          ? (notifications as NotificationService)
          : undefined;
      const closeOperations: Array<() => void | Promise<void>> = [
        ...enginesToClose.map((engine) => () => engine.close()),
        () => resultStore.close(),
      ];
      if (ownedNotifications !== undefined) {
        closeOperations.push(() => ownedNotifications.close());
      }
      const resourceResults = await Promise.allSettled(
        closeOperations.map((operation) => Promise.resolve().then(operation)),
      );
      errors.push(...rejectedReasons(resourceResults));

      // DB は他のclose失敗にかかわらず最後に一度だけ閉じる。
      const databaseResult = await Promise.allSettled([Promise.resolve().then(() => db.close())]);
      errors.push(...rejectedReasons(databaseResult));
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Service resource close failed');
      }
    })();
    return closeResourcesPromise;
  };
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopAdmission();
    const abort = new AbortController();
    const context: ShutdownDrainContext = {
      deadlineAt: Date.now() + config.shutdownTimeoutMs,
      signal: abort.signal,
    };
    shutdownPromise = (async () => {
      const timeout = setTimeout(() => abort.abort(), config.shutdownTimeoutMs);
      timeout.unref?.();
      try {
        const errors: unknown[] = [];
        const drained = await Promise.allSettled([drain(context)]);
        errors.push(...rejectedReasons(drained));
        const closed = await Promise.allSettled([closeResources()]);
        errors.push(...rejectedReasons(closed));
        if (errors.length > 0) throw new AggregateError(errors, 'Service shutdown failed');
      } finally {
        clearTimeout(timeout);
      }
    })();
    return shutdownPromise;
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
    dashboards,
    savedQueries,
    documentShares,
    history,
    schedules,
    scheduleRuns,
    scheduler,
    alerts,
    alertEvaluator,
    alertDeliveries,
    alertDeliveryWorker,
    workflows,
    workflowRuns,
    workflowRunner,
    audit,
    resultStore,
    resultExpiry,
    notifications,
    github,
    githubSyncScheduler,
    githubGovernance,
    ai,
    aiRateLimiter,
    githubNow,
    reloadDatasources,
    reloadRbac,
    reloadConfig,
    get datasourceDependencyFiles() {
      return [...datasourceDependencyFiles];
    },
    stopAdmission,
    drain,
    closeResources,
    shutdown,
  };
}

function rejectedReasons(results: PromiseSettledResult<unknown>[]): unknown[] {
  return results.flatMap((result) => (result.status === 'rejected' ? [result.reason] : []));
}

async function settleServiceTasks(
  tasks: Promise<unknown>[],
  context: ShutdownDrainContext,
  label: string,
): Promise<void> {
  const allSettled = Promise.allSettled(tasks);
  const remainingMs = context.deadlineAt - Date.now();
  if (remainingMs <= 0 || context.signal.aborted) {
    throw new Error(`${label} timed out`);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbort: (() => void) | undefined;
  try {
    const results = await Promise.race([
      allSettled,
      new Promise<never>((_resolve, reject) => {
        const fail = (): void => reject(new Error(`${label} timed out`));
        timer = setTimeout(fail, remainingMs);
        timer.unref?.();
        context.signal.addEventListener('abort', fail, { once: true });
        removeAbort = () => context.signal.removeEventListener('abort', fail);
      }),
    ]);
    const errors = rejectedReasons(results);
    if (errors.length > 0) throw new AggregateError(errors, `${label} failed`);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}

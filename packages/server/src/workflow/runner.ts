/**
 * クエリワークフロー機能の実行エンジンと cron tick ループ。
 *
 * ワークフロー run をステージ順に実行し、ステージ内は並行する。
 * 失敗ポリシー (stop / continue) とリトライ、Query Guard、結果永続化を扱う。
 */
import type { WorkflowRunStatus, WorkflowStep, WorkflowStepRunStatus } from '@hubble/contracts';
import type { TrinoRequestContext } from '../trino/types';
import type { EstimateService } from '../query/estimateService';
import type { QueryEngine } from '../engine/types';
import { getEngineOrUndefined } from '../engine/resolve';
import { hasQueryWrite, roleAllowsDatasource, schedulePrincipalIdentity } from '../rbac/check';
import { effectiveGuardLimits } from '../rbac/guard';
import { resolveRoleForPrincipal } from '../rbac/resolve';
import type { LoadedRbac } from '../rbac/types';
import { assertQueryWriteAllowed } from '../rbac/writeCheck';
import type { ServerConfig } from '../config';
import {
  WorkflowRunClaimConflictError,
  type WorkflowRecord,
  type WorkflowRepository,
  type WorkflowRunRepository,
} from '../store/workflows';
import { drainStatementWithCapture } from './execute';
import { nextRunAfter } from '../schedule/cron';
import {
  backoffMs,
  classifyFailure,
  retryPolicyForStatement,
  shouldRetry,
} from '../schedule/retry';
import type { AuditJson, AuditLogger } from '../audit';
import type { ResultStore } from '../resultStore';
import { ResultJsonlCapture } from '../resultStore/jsonl';
import {
  cleanupUnlinkedResultObject,
  type ResultObjectDeletionQueue,
} from '../resultStore/objectCleanup';
import type { SchedulerConfig } from '../schedule/scheduler';
import type { GithubGovernanceService } from '../github/governance';
import {
  JobAdmissionRejectedError,
  type JobCapacityLease,
  type JobAdmissionController,
  type JobAdmissionLease,
} from '../schedule/admission';
import { PeriodicRunner } from '../util/periodicRunner';
import { raceSqlAbort } from '../engine/sql/abort';

export interface WorkflowRunnerConfig {
  enabled: boolean;
  tickSeconds: number;
  maxConcurrent: number;
  runsRetention: number;
  guardMode: SchedulerConfig['guardMode'];
}

export interface WorkflowRunnerDeps {
  workflows: WorkflowRepository;
  runs: WorkflowRunRepository;
  engines: Map<string, QueryEngine>;
  defaultDatasourceId: string;
  estimate: EstimateService;
  getRbac: () => LoadedRbac;
  guardConfig: ServerConfig['guard'];
  audit?: AuditLogger;
  resultStore: ResultStore;
  /** DB 未関連 object の削除を再試行する durable outbox。 */
  resultObjectDeletions: ResultObjectDeletionQueue;
  resultKeyPrefix?: string;
  resultTtlDays?: number;
  githubGovernance: GithubGovernanceService;
  /** schedule、workflow、alert で共有する実行枠。 */
  admission: JobAdmissionController;
  config: WorkflowRunnerConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

interface StepOutcome {
  status: WorkflowStepRunStatus;
  attempt: number;
  rowCount: number | null;
  errorType: string | null;
  errorMessage: string | null;
  resultObjectKey?: string | null;
  resultExpiresAt?: string | null;
}

/**
 * 同一ワークフローの run が既に進行中のときに `runManual` が投げるエラー。
 * routes 層はこの型のみを 409 CONFLICT へ変換し、それ以外の失敗は伝播させる。
 */
export class WorkflowRunInProgressError extends Error {
  constructor(workflowId: string) {
    super(`A run is already in progress for workflow ${workflowId}`);
    this.name = 'WorkflowRunInProgressError';
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// 省略時の setTimeout と unref は PeriodicRunner が共通実装する。

/** ワークフロー実行と cron tick を担う。 */
export class WorkflowRunner {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly periodic: PeriodicRunner;
  private readonly shutdownAbort = new AbortController();
  private readonly nextFire = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private readonly starting = new Set<Promise<void>>();
  // tick timer と進行中の走査は PeriodicRunner が所有する。
  private started = false;
  private stopping = false;

  constructor(private deps: WorkflowRunnerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.periodic = new PeriodicRunner({
      intervalMs: deps.config.tickSeconds * 1_000,
      task: () => this.tick(),
      logError: (message, error) => console.error(message, error),
      errorMessage: 'workflow: periodic tick failed',
      ...(deps.setTimer ? { setTimer: deps.setTimer } : {}),
    });
  }

  setDefaultDatasourceId(id: string): void {
    this.deps.defaultDatasourceId = id;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.deps.runs.abortOrphans(new Date(this.now()).toISOString());
    if (!this.deps.config.enabled) return;
    await this.seedNextFires();
    this.periodic.start();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.shutdownAbort.abort();
    await this.periodic.stop();
    await this.drainLifecycleTasks();
  }

  async whenIdle(): Promise<void> {
    await this.drainLifecycleTasks();
  }

  get activeRuns(): number {
    return this.inFlight.size;
  }

  async runManual(workflow: WorkflowRecord): Promise<{ runId: string }> {
    const admissionLease = this.deps.admission.tryAcquire('workflow', workflow.id);
    const scheduledForIso = new Date(this.now()).toISOString();
    this.inFlight.add(workflow.id);
    let finishStarting!: () => void;
    const starting = new Promise<void>((resolve) => {
      finishStarting = resolve;
    });
    this.starting.add(starting);
    try {
      const runId = await this.deps.runs.startRun(
        workflow,
        'manual',
        scheduledForIso,
        scheduledForIso,
      );
      admissionLease.releaseCapacity();
      const p = this.executeRun(workflow, runId, 'manual', scheduledForIso)
        .catch((err: unknown) => {
          console.error(`workflow: unexpected error in manual run ${workflow.id}`, err);
        })
        .finally(() => {
          this.inFlight.delete(workflow.id);
          this.running.delete(workflow.id);
          admissionLease.release();
        });
      this.running.set(workflow.id, p);
      return { runId };
    } catch (err) {
      this.inFlight.delete(workflow.id);
      admissionLease.release();
      if (err instanceof WorkflowRunClaimConflictError) {
        throw new WorkflowRunInProgressError(workflow.id);
      }
      throw err;
    } finally {
      this.starting.delete(starting);
      finishStarting();
    }
  }

  private async drainLifecycleTasks(): Promise<void> {
    for (;;) {
      const tasks = [...this.starting, ...this.running.values()];
      if (tasks.length === 0) return;
      await Promise.allSettled(tasks);
    }
  }

  private async seedNextFires(): Promise<void> {
    const now = new Date(this.now());
    const workflows = await this.deps.workflows.listAllEnabled();
    for (const w of workflows) {
      if (!w.cron) continue;
      if (!this.nextFire.has(w.id)) {
        const next = nextRunAfter(w.cron, now);
        if (next !== null) this.nextFire.set(w.id, next);
      }
    }
  }

  // PeriodicRunner は tick の失敗をログへ隔離してから次の単発 timer を予約する。

  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = this.now();
    const workflows = await this.deps.workflows.listAllEnabled();
    const live = new Set(workflows.map((w) => w.id));
    for (const id of this.nextFire.keys()) {
      if (!live.has(id)) this.nextFire.delete(id);
    }

    for (const workflow of workflows) {
      if (!workflow.cron) continue;
      const fireAt = this.nextFire.get(workflow.id);
      if (fireAt === undefined) {
        const next = nextRunAfter(workflow.cron, new Date(now));
        if (next !== null) this.nextFire.set(workflow.id, next);
        continue;
      }
      if (now < fireAt) continue;

      const scheduledFor = fireAt;
      const next = nextRunAfter(workflow.cron, new Date(now));
      if (next !== null) this.nextFire.set(workflow.id, next);
      else this.nextFire.delete(workflow.id);

      let lease: JobAdmissionLease;
      try {
        lease = this.deps.admission.tryAcquire('workflow', workflow.id);
      } catch (err) {
        if (err instanceof JobAdmissionRejectedError) continue;
        throw err;
      }

      this.launch(workflow, new Date(scheduledFor).toISOString(), lease);
    }
  }

  private launch(
    workflow: WorkflowRecord,
    scheduledForIso: string,
    admissionLease: JobAdmissionLease,
  ): void {
    this.inFlight.add(workflow.id);
    const p = this.runOnce(workflow, scheduledForIso, admissionLease)
      .catch((err: unknown) => {
        console.error(`workflow: unexpected error running workflow ${workflow.id}`, err);
      })
      .finally(() => {
        this.inFlight.delete(workflow.id);
        this.running.delete(workflow.id);
        admissionLease.release();
      });
    this.running.set(workflow.id, p);
  }

  private async runOnce(
    workflow: WorkflowRecord,
    scheduledForIso: string,
    admissionLease: JobAdmissionLease,
  ): Promise<void> {
    const startedAt = new Date(this.now()).toISOString();
    const runId = await this.deps.runs.startRun(workflow, 'cron', scheduledForIso, startedAt);
    admissionLease.releaseCapacity();
    const governance = this.deps.githubGovernance;
    if (governance.enabled && !(await governance.isWorkflowApproved(workflow))) {
      await this.finishGovernanceBlockedRun(workflow, runId, 'cron', scheduledForIso, startedAt);
      return;
    }
    await this.executeRun(workflow, runId, 'cron', scheduledForIso);
  }

  private async finishGovernanceBlockedRun(
    workflow: WorkflowRecord,
    runId: string,
    trigger: 'manual' | 'cron',
    scheduledForIso: string,
    startedAtIso: string,
  ): Promise<void> {
    const finishedMs = this.now();
    const elapsedMs = Math.max(finishedMs - Date.parse(startedAtIso), 0);
    const finishedAt = new Date(finishedMs).toISOString();
    await this.deps.runs.skipRemaining(runId, 0, finishedAt);
    await this.deps.runs.finishRun(runId, workflow.id, {
      status: 'blocked',
      finishedAt,
      elapsedMs,
    });
    const finalRun = await this.deps.runs.getRun(runId);
    if (finalRun) {
      await this.recordWorkflowOutcome(workflow, runId, trigger, scheduledForIso, finalRun, {
        governance: 'blocked',
      });
    }
  }

  /** principal snapshot が無い歴史的 workflow を実行せず blocked で確定する。 */
  private async finishPrincipalSnapshotBlockedRun(
    workflow: WorkflowRecord,
    runId: string,
    trigger: 'manual' | 'cron',
    scheduledForIso: string,
    startedAtIso: string,
  ): Promise<void> {
    const finishedMs = this.now();
    const elapsedMs = Math.max(finishedMs - Date.parse(startedAtIso), 0);
    const finishedAt = new Date(finishedMs).toISOString();
    await this.deps.runs.skipRemaining(runId, 0, finishedAt);
    await this.deps.runs.finishRun(runId, workflow.id, {
      status: 'blocked',
      finishedAt,
      elapsedMs,
    });
    const finalRun = await this.deps.runs.getRun(runId);
    if (finalRun) {
      await this.recordWorkflowOutcome(workflow, runId, trigger, scheduledForIso, finalRun, {
        principalSnapshot: 'required',
      });
    }
  }

  private async executeRun(
    workflow: WorkflowRecord,
    runId: string,
    trigger: 'manual' | 'cron',
    scheduledForIso: string,
  ): Promise<void> {
    if (!workflow.principalSnapshot) {
      await this.finishPrincipalSnapshotBlockedRun(
        workflow,
        runId,
        trigger,
        scheduledForIso,
        new Date(this.now()).toISOString(),
      );
      return;
    }
    const startMs = this.now();
    const persistStepResults =
      !this.deps.githubGovernance.enabled ||
      (await this.deps.githubGovernance.isWorkflowApproved(workflow));
    const workflowRole = resolveRoleForPrincipal(
      this.deps.getRbac(),
      schedulePrincipalIdentity(workflow.owner, workflow.principalSnapshot),
    );

    const runDetail = await this.deps.runs.getRun(runId);
    if (!runDetail) return;

    const stepById = new Map<string, { step: WorkflowStep; stageIndex: number }>();
    for (let stageIndex = 0; stageIndex < workflow.stages.length; stageIndex += 1) {
      for (const step of workflow.stages[stageIndex]!.steps) {
        stepById.set(step.id, { step, stageIndex });
      }
    }

    let runStatus: WorkflowRunStatus = 'success';
    let abortFromStage: number | null = null;

    for (let stageIndex = 0; stageIndex < workflow.stages.length; stageIndex += 1) {
      if (abortFromStage !== null) break;
      if (this.shutdownAbort.signal.aborted) {
        runStatus = 'aborted';
        await this.deps.runs.skipRemaining(runId, stageIndex, new Date(this.now()).toISOString());
        break;
      }
      const stageSteps = runDetail.steps.filter((s) => s.stageIndex === stageIndex);
      const outcomes = await Promise.all(
        stageSteps.map((stepRun) =>
          this.executeStepWithCapacity(
            workflow,
            workflowRole,
            runId,
            stepRun.id,
            stepById,
            persistStepResults,
          ),
        ),
      );

      for (let i = 0; i < stageSteps.length; i += 1) {
        const stepRun = stageSteps[i]!;
        const outcome = outcomes[i]!;
        const def = stepById.get(stepRun.stepId);
        if (outcome.status === 'aborted') {
          abortFromStage = stageIndex;
          runStatus = 'aborted';
          break;
        }
        if (
          def &&
          (outcome.status === 'failed' || outcome.status === 'blocked') &&
          def.step.onFailure === 'stop'
        ) {
          abortFromStage = stageIndex;
          runStatus = 'failed';
          break;
        }
      }

      if (abortFromStage !== null) {
        await this.deps.runs.skipRemaining(
          runId,
          abortFromStage + 1,
          new Date(this.now()).toISOString(),
        );
        break;
      }

      const hasFailure = outcomes.some((o) => o.status === 'failed' || o.status === 'blocked');
      if (hasFailure) runStatus = 'partial';
    }

    const finishedMs = this.now();
    const elapsedMs = Math.max(finishedMs - startMs, 0);
    const finishedAt = new Date(finishedMs).toISOString();
    await this.deps.runs.finishRun(runId, workflow.id, {
      status: runStatus,
      finishedAt,
      elapsedMs,
    });

    const finalRun = await this.deps.runs.getRun(runId);
    if (finalRun) {
      await this.recordWorkflowOutcome(workflow, runId, trigger, scheduledForIso, finalRun);
    }
  }

  private async executeStepWithCapacity(
    workflow: WorkflowRecord,
    workflowRole: ReturnType<typeof resolveRoleForPrincipal>,
    runId: string,
    stepRunId: string,
    stepById: Map<string, { step: WorkflowStep; stageIndex: number }>,
    persistStepResults: boolean,
  ): Promise<StepOutcome> {
    let capacityLease: JobCapacityLease;
    try {
      capacityLease = await this.deps.admission.acquireCapacity(this.shutdownAbort.signal);
    } catch (err) {
      if (!this.shutdownAbort.signal.aborted) throw err;
      // pending のまま残さないため、DB終端処理を持つ通常経路へ中断状態で渡す。
      return this.executeStep(
        workflow,
        workflowRole,
        runId,
        stepRunId,
        stepById,
        persistStepResults,
      );
    }
    try {
      return await this.executeStep(
        workflow,
        workflowRole,
        runId,
        stepRunId,
        stepById,
        persistStepResults,
      );
    } finally {
      capacityLease.release();
    }
  }

  private async executeStep(
    workflow: WorkflowRecord,
    workflowRole: ReturnType<typeof resolveRoleForPrincipal>,
    runId: string,
    stepRunId: string,
    stepById: Map<string, { step: WorkflowStep; stageIndex: number }>,
    persistStepResults: boolean,
  ): Promise<StepOutcome> {
    const runDetail = await this.deps.runs.getRun(runId);
    const stepRun = runDetail?.steps.find((s) => s.id === stepRunId);
    if (!stepRun) {
      return {
        status: 'failed',
        attempt: 1,
        rowCount: null,
        errorType: 'INTERNAL',
        errorMessage: 'Step run not found',
      };
    }
    const def = stepById.get(stepRun.stepId);
    if (!def) {
      return {
        status: 'failed',
        attempt: 1,
        rowCount: null,
        errorType: 'INTERNAL',
        errorMessage: 'Step definition not found',
      };
    }
    const step = def.step;
    const startedAt = new Date(this.now()).toISOString();
    await this.deps.runs.markStepRunning(stepRunId, startedAt);
    const stepStartMs = this.now();
    const outcome = await this.attemptStepWithRetries(
      workflow,
      workflowRole,
      step,
      step.datasourceId ?? workflow.datasourceId,
      runId,
      stepRunId,
      persistStepResults,
    );
    const finishedAt = new Date(this.now()).toISOString();
    const elapsedMs = Math.max(this.now() - stepStartMs, 0);
    try {
      await this.deps.runs.finishStep(stepRunId, {
        status: outcome.status,
        attempt: outcome.attempt,
        rowCount: outcome.rowCount,
        elapsedMs,
        errorType: outcome.errorType,
        errorMessage: outcome.errorMessage,
        resultObjectKey: outcome.resultObjectKey ?? null,
        resultExpiresAt: outcome.resultExpiresAt ?? null,
        finishedAt,
      });
    } catch (error) {
      if (outcome.resultObjectKey) await this.cleanupResultObject(outcome.resultObjectKey);
      throw error;
    }
    return outcome;
  }

  private async attemptStepWithRetries(
    workflow: WorkflowRecord,
    workflowRole: ReturnType<typeof resolveRoleForPrincipal>,
    step: WorkflowStep,
    datasourceId: string,
    runId: string,
    stepRunId: string,
    persistStepResults: boolean,
  ): Promise<StepOutcome> {
    const policy = retryPolicyForStatement(workflow.retry, step.statement);
    let attempt = 0;
    const effective = effectiveGuardLimits(this.deps.guardConfig, workflowRole);

    const engine = getEngineOrUndefined(this.deps.engines, datasourceId);
    if (!engine) {
      return {
        status: 'failed',
        attempt: 1,
        rowCount: null,
        errorType: 'NOT_CONFIGURED',
        errorMessage: `Datasource '${datasourceId}' is not configured`,
      };
    }

    if (!roleAllowsDatasource(workflowRole, datasourceId)) {
      return {
        status: 'blocked',
        attempt: 1,
        rowCount: null,
        errorType: 'DATASOURCE_ACCESS_DENIED',
        errorMessage: `Datasource '${datasourceId}' is not allowed for this role`,
      };
    }

    const releaseLease = engine.lease?.() ?? (() => {});
    try {
      for (;;) {
        if (this.shutdownAbort.signal.aborted) return this.abortedStepOutcome(attempt);
        attempt += 1;

        try {
          const ioExplain = engine.ioExplainExecution?.({
            statement: step.statement,
            catalog: step.catalog ?? undefined,
            schema: step.schema ?? undefined,
            principal: workflow.owner,
          });
          await assertQueryWriteAllowed({
            statement: step.statement,
            role: workflowRole,
            ioExplainClient: ioExplain?.client,
            ioExplainCtx: ioExplain?.ctx,
            ioExplainTimeoutMs: this.deps.guardConfig.estimateTimeoutMs,
          });
        } catch (err) {
          if (this.shutdownAbort.signal.aborted) return this.abortedStepOutcome(attempt);
          return {
            status: 'failed',
            attempt,
            rowCount: null,
            errorType: errorTypeOf(err),
            errorMessage: err instanceof Error ? err.message : String(err),
          };
        }

        const validation = await engine.validate({
          statement: step.statement,
          catalog: step.catalog ?? null,
          schema: step.schema ?? null,
          principal: workflow.owner,
          roleName: workflowRole.name,
        });
        if (!validation.ok && validation.kind === 'user_error') {
          return {
            status: 'failed',
            attempt,
            rowCount: null,
            errorType: 'USER_ERROR',
            errorMessage: locationMessage(validation),
          };
        }
        if (!validation.ok) {
          const transient = this.maybeRetryStep(
            attempt,
            policy,
            'TRINO_UNAVAILABLE',
            validation.message,
          );
          if (transient) return transient;
          await this.waitBeforeRetry(policy, attempt);
          continue;
        }

        if (effective.mode === 'enforce' && engine.capabilities.costEstimate) {
          const estimate = await this.deps.estimate.estimate({
            statement: step.statement,
            catalog: step.catalog ?? undefined,
            schema: step.schema ?? undefined,
            principal: workflow.owner,
            datasourceId,
            roleName: workflowRole.name,
            guard: effective,
          });
          if (estimate.verdict.decision === 'block') {
            return {
              status: 'blocked',
              attempt,
              rowCount: null,
              errorType: 'QUERY_BLOCKED',
              errorMessage: estimate.verdict.reasons.join('; ') || 'Blocked by Query Guard',
            };
          }
        }

        const capture = persistStepResults ? this.createResultCapture(runId, stepRunId) : undefined;
        try {
          const client = engine.executionClient({
            source: 'scheduled',
            user: workflow.owner,
            roleName: workflowRole.name,
            sessionReadOnly: !hasQueryWrite(workflowRole),
          });
          const ctx: TrinoRequestContext = {
            catalog: step.catalog ?? undefined,
            schema: step.schema ?? undefined,
            user: workflow.owner,
          };
          const result = await drainStatementWithCapture(
            client,
            step.statement,
            ctx,
            capture,
            this.shutdownAbort.signal,
          );
          if (capture) {
            if (this.shutdownAbort.signal.aborted) {
              await capture.abort();
              return this.abortedStepOutcome(attempt);
            }
            await capture.finish();
            if (this.shutdownAbort.signal.aborted) {
              await this.cleanupResultObject(capture.key);
              return this.abortedStepOutcome(attempt);
            }
            const expiresAt = this.resultExpiresAt();
            return {
              status: 'success',
              attempt,
              rowCount: result.rowCount,
              errorType: null,
              errorMessage: null,
              resultObjectKey: capture.key,
              resultExpiresAt: expiresAt,
            };
          }
          return {
            status: 'success',
            attempt,
            rowCount: result.rowCount,
            errorType: null,
            errorMessage: null,
          };
        } catch (err) {
          if (capture) await capture.abort();
          if (this.shutdownAbort.signal.aborted) return this.abortedStepOutcome(attempt);
          const failureClass = classifyFailure(err);
          const errorType = errorTypeOf(err);
          const message = err instanceof Error ? err.message : String(err);
          if (failureClass === 'deterministic') {
            return {
              status: 'failed',
              attempt,
              rowCount: null,
              errorType,
              errorMessage: message,
            };
          }
          const transient = this.maybeRetryStep(attempt, policy, errorType, message);
          if (transient) return transient;
          await this.waitBeforeRetry(policy, attempt);
        }
      }
    } catch (err) {
      if (this.shutdownAbort.signal.aborted) return this.abortedStepOutcome(attempt);
      throw err;
    } finally {
      releaseLease();
    }
  }

  private maybeRetryStep(
    attempt: number,
    policy: WorkflowRecord['retry'],
    errorType: string | null,
    message: string,
  ): StepOutcome | undefined {
    if (shouldRetry(policy, attempt)) return undefined;
    return {
      status: 'failed',
      attempt,
      rowCount: null,
      errorType,
      errorMessage: message,
    };
  }

  private async waitBeforeRetry(policy: WorkflowRecord['retry'], attempt: number): Promise<void> {
    await raceSqlAbort(this.sleep(backoffMs(policy, attempt)), this.shutdownAbort.signal);
  }

  private abortedStepOutcome(attempt: number): StepOutcome {
    return {
      status: 'aborted',
      attempt: Math.max(attempt, 1),
      rowCount: null,
      errorType: 'SERVER_SHUTDOWN',
      errorMessage: 'Step aborted during server shutdown',
    };
  }

  private createResultCapture(runId: string, stepRunId: string): ResultJsonlCapture | undefined {
    if (!this.deps.resultStore.enabled) return undefined;
    const prefix = this.deps.resultKeyPrefix ?? 'hubble-results/';
    return new ResultJsonlCapture(
      this.deps.resultStore,
      `${prefix}workflow/${runId}/${stepRunId}.jsonl.zst`,
    );
  }

  private resultExpiresAt(): string {
    const now = this.deps.now?.() ?? Date.now();
    const ttlDays = this.deps.resultTtlDays ?? 7;
    return new Date(now + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  }

  /** DB へ関連付けられなかった workflow result を削除または再試行登録する。 */
  private async cleanupResultObject(key: string): Promise<void> {
    await cleanupUnlinkedResultObject(key, {
      store: this.deps.resultStore,
      deletions: this.deps.resultObjectDeletions,
      now: this.deps.now,
      logWarn: (message, error) => console.warn(`workflow: ${message}`, error),
    });
  }

  private async recordWorkflowOutcome(
    workflow: WorkflowRecord,
    runId: string,
    trigger: 'manual' | 'cron',
    scheduledForIso: string,
    run: NonNullable<Awaited<ReturnType<WorkflowRunRepository['getRun']>>>,
    extraDetail?: Record<string, AuditJson>,
  ): Promise<void> {
    if (!this.deps.audit) return;
    const detail: Record<string, AuditJson> = {
      runId,
      trigger,
      scheduledFor: scheduledForIso,
      status: run.status,
      stepCounts: run.stepCounts as unknown as AuditJson,
      steps: run.steps.map((s) => ({
        stepId: s.stepId,
        status: s.status,
        rowCount: s.rowCount,
        errorType: s.errorType,
      })) as unknown as AuditJson,
      ...extraDetail,
    };
    await this.deps.audit.record({
      actor: workflow.owner,
      action: 'workflow.execute',
      target: workflow.id,
      datasource: workflow.datasourceId,
      detail,
    });
  }
}

function locationMessage(v: { message: string; line?: number; column?: number }): string {
  if (v.line !== undefined && v.column !== undefined) {
    return `${v.message} (line ${v.line}:${v.column})`;
  }
  return v.message;
}

function errorTypeOf(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const maybeTrino = err as { trino?: { errorType?: string }; detail?: { code?: string } };
    if (maybeTrino.trino?.errorType) return maybeTrino.trino.errorType;
    if (maybeTrino.detail?.code) return maybeTrino.detail.code;
  }
  return null;
}

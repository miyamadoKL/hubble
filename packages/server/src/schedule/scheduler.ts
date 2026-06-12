import type { ScheduleRunStatus } from '@hubble/contracts';
import type { TrinoClient } from '../trino/client';
import type { TrinoRequestContext } from '../trino/types';
import type { EstimateService } from '../query/estimateService';
import type { ScheduleRecord, ScheduleRepository, ScheduleRunRepository } from '../store/schedules';
import { drainStatement } from './execute';
import { nextRunAfter } from './cron';
import { backoffMs, classifyFailure, shouldRetry } from './retry';
import { StatementValidator } from './validator';

/** Resolved scheduler settings. */
export interface SchedulerConfig {
  enabled: boolean;
  tickSeconds: number;
  maxConcurrent: number;
  runsRetention: number;
  /** `enforce` applies Query Guard blocking to scheduled runs. */
  guardMode: 'off' | 'warn' | 'enforce';
}

export interface SchedulerDeps {
  schedules: ScheduleRepository;
  runs: ScheduleRunRepository;
  /** Trino client tagged with the scheduled source + run as the owner. */
  client: TrinoClient;
  validator: StatementValidator;
  estimate: EstimateService;
  config: SchedulerConfig;
  /** `X-Trino-Source` for scheduled runs. */
  source: string;
  /** Wall clock (injectable for tests). */
  now?: () => number;
  /** Backoff sleep between retries (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
  /** setTimeout shim returning a clearable handle (injectable for tests). */
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

/** Terminal outcome of a single run (before persistence). */
interface RunOutcome {
  status: ScheduleRunStatus;
  attempt: number;
  trinoQueryId: string | null;
  errorType: string | null;
  errorMessage: string | null;
  rowCount: number | null;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function defaultSetTimer(fn: () => void, ms: number): { clear: () => void } {
  const handle = setTimeout(fn, ms);
  if (typeof handle === 'object' && 'unref' in handle) (handle as { unref: () => void }).unref();
  return { clear: () => clearTimeout(handle) };
}

/**
 * In-process query scheduler (Query Scheduling feature).
 *
 * A single tick loop scans enabled schedules every `tickSeconds`, fires any that
 * are due (next cron time has passed), and records a `schedule_runs` row per
 * firing. Each run validates the statement with `EXPLAIN (TYPE VALIDATE)` and
 * (in `enforce` guard mode) checks the scan estimate before executing; transient
 * failures retry per the schedule's policy, while deterministic failures
 * (USER_ERROR, guard block) fail immediately.
 *
 * Next-run times are computed from "now" (never backfilled), so a stopped server
 * skips missed fires and resumes at the next future occurrence. Overlap is
 * prevented per schedule, and total concurrency is capped by `maxConcurrent`.
 */
export class Scheduler {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setTimer: (fn: () => void, ms: number) => { clear: () => void };

  /** Next fire time (epoch ms) per schedule id, computed from "now". */
  private readonly nextFire = new Map<string, number>();
  /** Schedule ids with an in-flight run (overlap guard). */
  private readonly inFlight = new Set<string>();
  /** Promises for in-flight runs, awaited on shutdown. */
  private readonly running = new Map<string, Promise<void>>();

  private tickHandle?: { clear: () => void };
  private started = false;
  private stopping = false;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? defaultSleep;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
  }

  /**
   * Recover crashed runs and start the tick loop. Safe to call when disabled
   * (recovery still runs; the loop does not start). Idempotent.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    // Crash recovery: any run left `running` from a previous process is aborted.
    await this.deps.runs.abortOrphans(new Date(this.now()).toISOString());
    if (!this.deps.config.enabled) return;
    await this.seedNextFires();
    this.scheduleTick();
  }

  /** Stop the tick loop and await any in-flight runs (graceful shutdown). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.tickHandle?.clear();
    this.tickHandle = undefined;
    await Promise.allSettled([...this.running.values()]);
  }

  /** Await all currently in-flight runs to settle (no-op if idle). */
  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  /** Number of schedules with an in-flight run (overlap/concurrency view). */
  get activeRuns(): number {
    return this.inFlight.size;
  }

  /** Seed `nextFire` for every enabled schedule from the current time. */
  private async seedNextFires(): Promise<void> {
    const now = new Date(this.now());
    const schedules = await this.deps.schedules.listAllEnabled();
    for (const s of schedules) {
      if (!this.nextFire.has(s.id)) {
        const next = nextRunAfter(s.cron, now);
        if (next !== null) this.nextFire.set(s.id, next);
      }
    }
  }

  private scheduleTick(): void {
    if (this.stopping) return;
    this.tickHandle = this.setTimer(() => {
      void this.tick().finally(() => this.scheduleTick());
    }, this.deps.config.tickSeconds * 1000);
  }

  /**
   * One scan: fire every schedule whose next time has passed (subject to overlap
   * and concurrency limits). Exposed for tests to drive deterministically.
   */
  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = this.now();
    const schedules = await this.deps.schedules.listAllEnabled();
    const live = new Set(schedules.map((s) => s.id));
    // Forget schedules that were disabled/deleted since the last scan.
    for (const id of this.nextFire.keys()) {
      if (!live.has(id)) this.nextFire.delete(id);
    }

    for (const schedule of schedules) {
      const fireAt = this.nextFire.get(schedule.id);
      if (fireAt === undefined) {
        // Newly enabled since startup: seed without firing immediately.
        const next = nextRunAfter(schedule.cron, new Date(now));
        if (next !== null) this.nextFire.set(schedule.id, next);
        continue;
      }
      if (now < fireAt) continue;

      // Due. Advance the next fire time first so a long run can't double-fire,
      // then attempt to launch (respecting overlap + concurrency).
      const scheduledFor = fireAt;
      const next = nextRunAfter(schedule.cron, new Date(now));
      if (next !== null) this.nextFire.set(schedule.id, next);
      else this.nextFire.delete(schedule.id);

      if (this.inFlight.has(schedule.id)) continue; // overlap: skip this fire
      if (this.inFlight.size >= this.deps.config.maxConcurrent) continue; // at cap

      this.launch(schedule, new Date(scheduledFor).toISOString());
    }
  }

  /** Begin an async run, tracking it for overlap/shutdown bookkeeping. */
  private launch(schedule: ScheduleRecord, scheduledForIso: string): void {
    this.inFlight.add(schedule.id);
    const p = this.runOnce(schedule, scheduledForIso)
      .catch((err: unknown) => {
        // runOnce already persists outcomes; this guards an unexpected throw.
        console.error(`scheduler: unexpected error running schedule ${schedule.id}`, err);
      })
      .finally(() => {
        this.inFlight.delete(schedule.id);
        this.running.delete(schedule.id);
      });
    this.running.set(schedule.id, p);
  }

  /**
   * Manual run trigger (`POST /api/schedules/:id/run`). Uses the same execution
   * path and policy as the tick. Returns the run id, or throws if a run is
   * already in flight for this schedule. `scheduledFor` defaults to now.
   */
  async runManual(schedule: ScheduleRecord): Promise<{ runId: string }> {
    if (this.inFlight.has(schedule.id) || (await this.deps.runs.hasRunning(schedule.id))) {
      throw new Error('A run is already in progress for this schedule');
    }
    const scheduledForIso = new Date(this.now()).toISOString();
    this.inFlight.add(schedule.id);
    let runId: string;
    try {
      runId = await this.deps.runs.start({
        scheduleId: schedule.id,
        owner: schedule.owner,
        scheduledFor: scheduledForIso,
        startedAt: scheduledForIso,
      });
    } catch (err) {
      this.inFlight.delete(schedule.id);
      throw err;
    }
    // Execute in the background; the route returns immediately with the run id.
    const p = this.executeRun(schedule, runId)
      .catch((err: unknown) => {
        console.error(`scheduler: unexpected error in manual run ${schedule.id}`, err);
      })
      .finally(() => {
        this.inFlight.delete(schedule.id);
        this.running.delete(schedule.id);
      });
    this.running.set(schedule.id, p);
    return { runId };
  }

  /** Insert the run row then execute (used by the tick path). */
  private async runOnce(schedule: ScheduleRecord, scheduledForIso: string): Promise<void> {
    const runId = await this.deps.runs.start({
      scheduleId: schedule.id,
      owner: schedule.owner,
      scheduledFor: scheduledForIso,
      startedAt: new Date(this.now()).toISOString(),
    });
    await this.executeRun(schedule, runId);
  }

  /**
   * Drive validation, guard, execution, and retries for a single run, then
   * persist the terminal outcome. Never throws (failures are recorded).
   */
  private async executeRun(schedule: ScheduleRecord, runId: string): Promise<void> {
    const startMs = this.now();
    const outcome = await this.attemptWithRetries(schedule);
    const finishedMs = this.now();
    await this.deps.runs.finish(runId, schedule.id, {
      status: outcome.status,
      attempt: outcome.attempt,
      trinoQueryId: outcome.trinoQueryId,
      errorType: outcome.errorType,
      errorMessage: outcome.errorMessage,
      rowCount: outcome.rowCount,
      elapsedMs: Math.max(finishedMs - startMs, 0),
      finishedAt: new Date(finishedMs).toISOString(),
    });
  }

  /**
   * Run the validate -> guard -> execute pipeline with the schedule's retry
   * policy. Returns a terminal outcome; `attempt` is the number of attempts made.
   */
  private async attemptWithRetries(schedule: ScheduleRecord): Promise<RunOutcome> {
    const policy = schedule.retry;
    let attempt = 0;

    for (;;) {
      attempt += 1;

      // 1. Pre-flight validation (EXPLAIN VALIDATE). USER_ERROR is deterministic.
      const validation = await this.deps.validator.validate({
        statement: schedule.statement,
        catalog: schedule.catalog,
        schema: schedule.schema,
        principal: schedule.owner,
      });
      if (!validation.ok && validation.kind === 'user_error') {
        return {
          status: 'failed',
          attempt,
          trinoQueryId: null,
          errorType: 'USER_ERROR',
          errorMessage: locationMessage(validation),
          rowCount: null,
        };
      }
      // `unavailable` validation (Trino unreachable) is a transient fault: fall
      // through to the catch via a thrown transport-style execution below — but
      // we can short-circuit and treat it as a transient failure directly.
      if (!validation.ok) {
        const transientOutcome = this.maybeRetry(
          attempt,
          policy,
          'TRINO_UNAVAILABLE',
          validation.message,
        );
        if (transientOutcome) return transientOutcome;
        await this.waitBeforeRetry(policy, attempt);
        continue;
      }

      // 2. Query Guard (enforce mode only): a block is deterministic.
      if (this.deps.config.guardMode === 'enforce') {
        const estimate = await this.deps.estimate.estimate({
          statement: schedule.statement,
          catalog: schedule.catalog ?? undefined,
          schema: schedule.schema ?? undefined,
          principal: schedule.owner,
        });
        if (estimate.verdict.decision === 'block') {
          return {
            status: 'blocked',
            attempt,
            trinoQueryId: null,
            errorType: 'QUERY_BLOCKED',
            errorMessage: estimate.verdict.reasons.join('; ') || 'Blocked by Query Guard',
            rowCount: null,
          };
        }
      }

      // 3. Execute.
      try {
        const ctx: TrinoRequestContext = {
          catalog: schedule.catalog ?? undefined,
          schema: schedule.schema ?? undefined,
          source: this.deps.source,
          user: schedule.owner,
        };
        const result = await drainStatement(this.deps.client, schedule.statement, ctx);
        return {
          status: 'success',
          attempt,
          trinoQueryId: result.trinoQueryId,
          errorType: null,
          errorMessage: null,
          rowCount: result.rowCount,
        };
      } catch (err) {
        const failureClass = classifyFailure(err);
        const errorType = errorTypeOf(err);
        const message = err instanceof Error ? err.message : String(err);
        if (failureClass === 'deterministic') {
          return {
            status: 'failed',
            attempt,
            trinoQueryId: null,
            errorType,
            errorMessage: message,
            rowCount: null,
          };
        }
        const transientOutcome = this.maybeRetry(attempt, policy, errorType, message);
        if (transientOutcome) return transientOutcome;
        await this.waitBeforeRetry(policy, attempt);
      }
    }
  }

  /**
   * If no further retry is allowed after `attempt` attempts, return the final
   * `failed` outcome; otherwise return undefined (the caller waits + retries).
   */
  private maybeRetry(
    attempt: number,
    policy: ScheduleRecord['retry'],
    errorType: string | null,
    message: string,
  ): RunOutcome | undefined {
    if (shouldRetry(policy, attempt)) return undefined;
    return {
      status: 'failed',
      attempt,
      trinoQueryId: null,
      errorType,
      errorMessage: message,
      rowCount: null,
    };
  }

  private async waitBeforeRetry(policy: ScheduleRecord['retry'], attempt: number): Promise<void> {
    // The upcoming retry index equals the number of attempts already made.
    await this.sleep(backoffMs(policy, attempt));
  }
}

/** Compose a USER_ERROR message with its line/column when present. */
function locationMessage(v: { message: string; line?: number; column?: number }): string {
  if (v.line !== undefined && v.column !== undefined) {
    return `${v.message} (line ${v.line}:${v.column})`;
  }
  return v.message;
}

/** Best-effort Trino error type / code from a thrown error. */
function errorTypeOf(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const maybeTrino = err as { trino?: { errorType?: string }; detail?: { code?: string } };
    if (maybeTrino.trino?.errorType) return maybeTrino.trino.errorType;
    if (maybeTrino.detail?.code) return maybeTrino.detail.code;
  }
  return null;
}

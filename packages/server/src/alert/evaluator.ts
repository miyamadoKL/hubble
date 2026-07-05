/**
 * Alert 評価ループ（`AlertEvaluator`）。
 *
 * cron 式に従って保存クエリを実行し、結果の監視カラムを閾値と比較して
 * state を更新する。評価のたびにオーナーの principal snapshot からロールを
 * 再解決し、データソース allowlist を強制する（scheduler.ts と同じ認可原則）。
 */
import type { AlertState, AlertEvalResponse } from '@hubble/contracts';
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
import type { AlertRecord, AlertRepository } from '../store/alerts';
import type { SavedQueryRepository } from '../store/savedQueries';
import { nextRunAfter } from '../schedule/cron';
import { classifyFailure } from '../schedule/retry';
import type { AuditJson, AuditLogger } from '../audit';
import type { AlertNotificationSender } from '../notification/service';
import { columnIndex, fetchStatementRows } from './execute';
import { compareThreshold, nextAlertState, selectObservedValue, shouldNotify } from './state';

export interface AlertEvaluatorConfig {
  enabled: boolean;
  tickSeconds: number;
  maxConcurrent: number;
  guardMode: 'off' | 'warn' | 'enforce';
}

export interface AlertEvaluatorDeps {
  alerts: AlertRepository;
  savedQueries: SavedQueryRepository;
  engines: Map<string, QueryEngine>;
  defaultDatasourceId: string;
  estimate: EstimateService;
  getRbac: () => LoadedRbac;
  guardConfig: ServerConfig['guard'];
  audit?: AuditLogger;
  notifications?: AlertNotificationSender;
  config: AlertEvaluatorConfig;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => { clear: () => void };
}

export type AlertEvalOutcome = AlertEvalResponse;

function defaultSetTimer(fn: () => void, ms: number): { clear: () => void } {
  const handle = setTimeout(fn, ms);
  if (typeof handle === 'object' && 'unref' in handle) (handle as { unref: () => void }).unref();
  return { clear: () => clearTimeout(handle) };
}

function stringifyObserved(value: unknown): string | null {
  if (value === undefined) return null;
  if (value === null) return 'null';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function errorTypeOf(err: unknown): string | null {
  if (err && typeof err === 'object') {
    const maybeTrino = err as { trino?: { errorType?: string }; detail?: { code?: string } };
    if (maybeTrino.trino?.errorType) return maybeTrino.trino.errorType;
    if (maybeTrino.detail?.code) return maybeTrino.detail.code;
  }
  return null;
}

/**
 * Alert の cron 評価ループ。scheduler と同様に tick ごとに期限到来分を非同期実行する。
 */
export class AlertEvaluator {
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => { clear: () => void };
  private readonly nextEval = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private readonly running = new Map<string, Promise<void>>();
  private tickHandle?: { clear: () => void };
  private started = false;
  private stopping = false;

  constructor(private deps: AlertEvaluatorDeps) {
    this.now = deps.now ?? Date.now;
    this.setTimer = deps.setTimer ?? defaultSetTimer;
  }

  setDefaultDatasourceId(id: string): void {
    this.deps.defaultDatasourceId = id;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (!this.deps.config.enabled) return;
    await this.seedNextEvals();
    this.scheduleTick();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.tickHandle?.clear();
    this.tickHandle = undefined;
    await Promise.allSettled([...this.running.values()]);
  }

  async whenIdle(): Promise<void> {
    await Promise.allSettled([...this.running.values()]);
  }

  get activeEvals(): number {
    return this.inFlight.size;
  }

  /** 手動評価（`POST /api/alerts/:id/eval`）。 */
  async evalManual(alert: AlertRecord): Promise<AlertEvalOutcome> {
    if (this.inFlight.has(alert.id)) {
      throw new Error('An evaluation is already in progress for this alert');
    }
    this.inFlight.add(alert.id);
    try {
      return await this.evaluateAlert(alert);
    } finally {
      this.inFlight.delete(alert.id);
    }
  }

  private async seedNextEvals(): Promise<void> {
    const now = new Date(this.now());
    const alerts = await this.deps.alerts.listAllUnmuted();
    for (const alert of alerts) {
      if (!this.nextEval.has(alert.id)) {
        const next = nextRunAfter(alert.cron, now);
        if (next !== null) this.nextEval.set(alert.id, next);
      }
    }
  }

  private scheduleTick(): void {
    if (this.stopping) return;
    this.tickHandle = this.setTimer(() => {
      void this.tick().finally(() => this.scheduleTick());
    }, this.deps.config.tickSeconds * 1000);
  }

  async tick(): Promise<void> {
    if (this.stopping) return;
    const now = this.now();
    const alerts = await this.deps.alerts.listAllUnmuted();
    const live = new Set(alerts.map((a) => a.id));
    for (const id of this.nextEval.keys()) {
      if (!live.has(id)) this.nextEval.delete(id);
    }

    for (const alert of alerts) {
      const evalAt = this.nextEval.get(alert.id);
      if (evalAt === undefined) {
        const next = nextRunAfter(alert.cron, new Date(now));
        if (next !== null) this.nextEval.set(alert.id, next);
        continue;
      }
      if (now < evalAt) continue;

      const next = nextRunAfter(alert.cron, new Date(now));
      if (next !== null) this.nextEval.set(alert.id, next);
      else this.nextEval.delete(alert.id);

      if (this.inFlight.has(alert.id)) continue;
      if (this.inFlight.size >= this.deps.config.maxConcurrent) continue;

      this.launch(alert);
    }
  }

  private launch(alert: AlertRecord): void {
    this.inFlight.add(alert.id);
    const p = this.evaluateAlert(alert)
      .catch((err: unknown) => {
        console.error(`alert evaluator: unexpected error for alert ${alert.id}`, err);
        return {
          previousState: alert.state,
          state: alert.state,
          conditionMet: false,
          observedValue: null,
          notified: false,
          errorType: 'INTERNAL',
          errorMessage: err instanceof Error ? err.message : String(err),
        } satisfies AlertEvalOutcome;
      })
      .finally(() => {
        this.inFlight.delete(alert.id);
        this.running.delete(alert.id);
      });
    this.running.set(
      alert.id,
      p.then(() => undefined),
    );
  }

  private async evaluateAlert(alert: AlertRecord): Promise<AlertEvalOutcome> {
    const previousState = alert.state;
    const savedQuery = await this.deps.savedQueries.getByIdUnscoped(alert.savedQueryId);
    if (!savedQuery) {
      return this.persistOutcome(alert, previousState, {
        conditionMet: false,
        observedValue: null,
        notified: false,
        errorType: 'NOT_FOUND',
        errorMessage: `Saved query '${alert.savedQueryId}' not found`,
      });
    }

    const datasourceId = savedQuery.datasourceId ?? this.deps.defaultDatasourceId;
    const engine = getEngineOrUndefined(this.deps.engines, datasourceId);
    if (!engine) {
      return this.persistOutcome(alert, previousState, {
        conditionMet: false,
        observedValue: null,
        notified: false,
        errorType: 'NOT_CONFIGURED',
        errorMessage: `Datasource '${datasourceId}' is not configured`,
      });
    }

    const alertRole = resolveRoleForPrincipal(
      this.deps.getRbac(),
      schedulePrincipalIdentity(alert.owner, alert.principalSnapshot),
    );
    if (!roleAllowsDatasource(alertRole, datasourceId)) {
      return this.persistOutcome(alert, previousState, {
        conditionMet: false,
        observedValue: null,
        notified: false,
        errorType: 'DATASOURCE_ACCESS_DENIED',
        errorMessage: `Datasource '${datasourceId}' is not allowed for this role`,
      });
    }

    const effective = effectiveGuardLimits(this.deps.guardConfig, alertRole);

    try {
      const ioExplain = engine.ioExplainExecution?.({
        statement: savedQuery.statement,
        catalog: savedQuery.catalog ?? undefined,
        schema: savedQuery.schema ?? undefined,
        principal: alert.owner,
      });
      await assertQueryWriteAllowed({
        statement: savedQuery.statement,
        role: alertRole,
        ioExplainClient: ioExplain?.client,
        ioExplainCtx: ioExplain?.ctx,
        ioExplainTimeoutMs: this.deps.guardConfig.estimateTimeoutMs,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.persistOutcome(alert, previousState, {
        conditionMet: false,
        observedValue: null,
        notified: false,
        errorType: errorTypeOf(err),
        errorMessage: message,
      });
    }

    const validation = await engine.validate({
      statement: savedQuery.statement,
      catalog: savedQuery.catalog,
      schema: savedQuery.schema,
      principal: alert.owner,
      roleName: alertRole.name,
    });
    if (!validation.ok && validation.kind === 'user_error') {
      return this.persistOutcome(alert, previousState, {
        conditionMet: false,
        observedValue: null,
        notified: false,
        errorType: 'USER_ERROR',
        errorMessage: validation.message,
      });
    }
    if (!validation.ok) {
      return this.persistOutcome(alert, previousState, {
        conditionMet: false,
        observedValue: null,
        notified: false,
        errorType: 'TRINO_UNAVAILABLE',
        errorMessage: validation.message,
      });
    }

    if (effective.mode === 'enforce' && engine.capabilities.costEstimate) {
      const estimate = await this.deps.estimate.estimate({
        statement: savedQuery.statement,
        catalog: savedQuery.catalog ?? undefined,
        schema: savedQuery.schema ?? undefined,
        principal: alert.owner,
        datasourceId,
        roleName: alertRole.name,
        guard: effective,
      });
      if (estimate.verdict.decision === 'block') {
        return this.persistOutcome(alert, previousState, {
          conditionMet: false,
          observedValue: null,
          notified: false,
          errorType: 'QUERY_BLOCKED',
          errorMessage: estimate.verdict.reasons.join('; ') || 'Blocked by Query Guard',
        });
      }
    }

    try {
      const client = engine.executionClient({
        source: 'alert',
        user: alert.owner,
        roleName: alertRole.name,
        sessionReadOnly: !hasQueryWrite(alertRole),
      });
      const ctx: TrinoRequestContext = {
        catalog: savedQuery.catalog ?? undefined,
        schema: savedQuery.schema ?? undefined,
        user: alert.owner,
      };
      const fetched = await fetchStatementRows(client, savedQuery.statement, ctx);
      const idx = columnIndex(fetched.columns, alert.columnName);
      if (idx < 0) {
        return this.persistOutcome(alert, previousState, {
          conditionMet: false,
          observedValue: null,
          notified: false,
          errorType: 'COLUMN_NOT_FOUND',
          errorMessage: `Column '${alert.columnName}' not found in query result`,
        });
      }
      const observed = selectObservedValue(fetched.rows, idx, alert.selector);
      const observedStr = stringifyObserved(observed);
      const conditionMet = compareThreshold({
        observed,
        op: alert.op,
        threshold: alert.value,
      });
      const newState = nextAlertState(previousState, conditionMet);
      const nowMs = this.now();
      const notify = shouldNotify({
        previousState,
        newState,
        rearm: alert.rearm,
        lastTriggeredAt: alert.lastTriggeredAt,
        nowMs,
        muted: alert.muted,
      });

      const outcome = await this.persistOutcome(alert, previousState, {
        conditionMet,
        observedValue: observedStr,
        newState,
        notified: notify,
        errorType: null,
        errorMessage: null,
      });

      if (notify) {
        void this.sendNotification(alert, outcome, savedQuery.name, datasourceId);
      }

      await this.recordAudit(alert, outcome, datasourceId);
      return outcome;
    } catch (err) {
      const failureClass = classifyFailure(err);
      const message = err instanceof Error ? err.message : String(err);
      const errorType = errorTypeOf(err);
      if (failureClass === 'deterministic') {
        return this.persistOutcome(alert, previousState, {
          conditionMet: false,
          observedValue: null,
          notified: false,
          errorType,
          errorMessage: message,
        });
      }
      return this.persistOutcome(alert, previousState, {
        conditionMet: false,
        observedValue: null,
        notified: false,
        errorType,
        errorMessage: message,
      });
    }
  }

  private async persistOutcome(
    alert: AlertRecord,
    previousState: AlertState,
    input: {
      conditionMet: boolean;
      observedValue: string | null;
      newState?: AlertState;
      notified: boolean;
      errorType: string | null;
      errorMessage: string | null;
    },
  ): Promise<AlertEvalOutcome> {
    const newState = input.newState ?? nextAlertState(previousState, input.conditionMet);
    const nowIso = new Date(this.now()).toISOString();
    const lastTriggeredAt =
      newState === 'triggered'
        ? input.notified
          ? nowIso
          : alert.lastTriggeredAt
        : alert.lastTriggeredAt;

    await this.deps.alerts.update(alert.owner, alert.id, {
      state: newState,
      lastTriggeredAt,
    });

    return {
      previousState,
      state: newState,
      conditionMet: input.conditionMet,
      observedValue: input.observedValue,
      notified: input.notified,
      errorType: input.errorType,
      errorMessage: input.errorMessage,
    };
  }

  private async sendNotification(
    alert: AlertRecord,
    outcome: AlertEvalOutcome,
    savedQueryName: string,
    datasourceId: string,
  ): Promise<void> {
    if (!this.deps.notifications) return;
    try {
      await this.deps.notifications.sendAlertTriggered({
        alert,
        outcome,
        savedQueryName,
        datasourceId,
        evaluatedAt: new Date(this.now()).toISOString(),
      });
    } catch (err) {
      console.warn(`alert evaluator: notification failed for alert ${alert.id}`, err);
    }
  }

  private async recordAudit(
    alert: AlertRecord,
    outcome: AlertEvalOutcome,
    datasourceId: string,
  ): Promise<void> {
    if (!this.deps.audit) return;
    await this.deps.audit.record({
      actor: alert.owner,
      action: 'alert.evaluate',
      target: alert.id,
      datasource: datasourceId,
      detail: {
        alertId: alert.id,
        savedQueryId: alert.savedQueryId,
        previousState: outcome.previousState,
        state: outcome.state,
        conditionMet: outcome.conditionMet,
        observedValue: outcome.observedValue,
        notified: outcome.notified,
        errorType: outcome.errorType,
        errorMessage: outcome.errorMessage,
      } satisfies Record<string, AuditJson>,
    });
  }
}

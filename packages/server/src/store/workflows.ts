/**
 * クエリワークフロー機能の永続化層。
 *
 * - `WorkflowRepository`: `workflows` テーブルに対する owner スコープ CRUD。
 * - `WorkflowRunRepository`: `workflow_runs` / `workflow_step_runs` の実行記録。
 *
 * SQLite / PostgreSQL の両方言で同じ SQL が動くことを想定する。
 */
import type {
  RetryPolicy,
  WorkflowDefinition,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowStepRun,
  WorkflowStepRunStatus,
} from '@hubble/contracts';
import {
  retryPolicySchema,
  workflowDefinitionSchema,
  workflowRunSummarySchema,
  workflowStepRunSchema,
} from '@hubble/contracts';
import type { PrincipalIdentity } from '../auth/principal';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { newId } from '../util/id';
import { schedulePrincipalSnapshotSchema, type SchedulePrincipalSnapshot } from './schedules';
import { likeParam } from './notebooks';
import { ResultObjectDeletionRepository } from './resultObjectDeletions';

const SQL_ID_CHUNK_SIZE = 500;

export type { SchedulePrincipalSnapshot };

/** DB に保存されているワークフロー (レスポンス専用フィールドは routes 層で付与)。 */
export interface WorkflowRecord {
  id: string;
  owner: string;
  name: string;
  description: string;
  stages: WorkflowDefinition;
  datasourceId: string;
  cron: string | null;
  enabled: boolean;
  retry: RetryPolicy;
  principalSnapshot: SchedulePrincipalSnapshot | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateWorkflowInput {
  name: string;
  description?: string;
  stages: WorkflowDefinition;
  datasourceId: string;
  cron?: string | null;
  enabled?: boolean;
  retry?: RetryPolicy;
  principalSnapshot?: PrincipalIdentity;
}

export interface UpdateWorkflowInput {
  name?: string;
  description?: string;
  stages?: WorkflowDefinition;
  datasourceId?: string;
  cron?: string | null;
  enabled?: boolean;
  retry?: RetryPolicy;
  principalSnapshot?: PrincipalIdentity;
}

interface WorkflowRow {
  id: string;
  name: string;
  description: string;
  stages: string;
  datasource_id: string;
  cron: string | null;
  enabled: number;
  retry: string;
  owner: string;
  principal_snapshot: string | null;
  created_at: string;
  updated_at: string;
}

type InvalidPrincipalSnapshotReason = 'json-parse' | 'schema-validate';

function warnInvalidPrincipalSnapshot(
  workflowId: string,
  reason: InvalidPrincipalSnapshotReason,
): void {
  console.warn(`workflow principal_snapshot ignored: workflow_id=${workflowId} reason=${reason}`);
}

function parsePrincipalSnapshot(
  workflowId: string,
  raw: string | null,
): SchedulePrincipalSnapshot | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    warnInvalidPrincipalSnapshot(workflowId, 'json-parse');
    return null;
  }
  const result = schedulePrincipalSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    warnInvalidPrincipalSnapshot(workflowId, 'schema-validate');
    return null;
  }
  return result.data;
}

function serializePrincipalSnapshot(snapshot: PrincipalIdentity | null | undefined): string | null {
  if (!snapshot) return null;
  return JSON.stringify(
    schedulePrincipalSnapshotSchema.parse({
      user: snapshot.user,
      ...(snapshot.email !== undefined ? { email: snapshot.email } : {}),
      ...(snapshot.groups !== undefined ? { groups: snapshot.groups } : {}),
    }),
  );
}

// stages 列の破損はフォールバックせず失敗させる。ダミー SQL への置き換えは
// 「定義に存在しない文が実行される」事故につながるため許容しない。
function parseStages(workflowId: string, raw: string): WorkflowDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(`workflow stages corrupted: workflow_id=${workflowId} reason=json-parse`);
  }
  const result = workflowDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`workflow stages corrupted: workflow_id=${workflowId} reason=schema-validate`);
  }
  return result.data;
}

function parseRetry(workflowId: string, raw: string): RetryPolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return retryPolicySchema.parse({});
  }
  const result = retryPolicySchema.safeParse(parsed);
  if (!result.success) {
    console.warn(`workflow retry ignored: workflow_id=${workflowId} reason=schema-validate`);
    return retryPolicySchema.parse({});
  }
  return result.data;
}

function rowToWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    description: row.description,
    stages: parseStages(row.id, row.stages),
    datasourceId: row.datasource_id,
    cron: row.cron ?? null,
    enabled: Number(row.enabled) !== 0,
    retry: parseRetry(row.id, row.retry),
    principalSnapshot: parsePrincipalSnapshot(row.id, row.principal_snapshot),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeRetry(retry: RetryPolicy): string {
  return JSON.stringify(retryPolicySchema.parse(retry));
}

function serializeStages(stages: WorkflowDefinition): string {
  return JSON.stringify(workflowDefinitionSchema.parse(stages));
}

/** workflows テーブルの CRUD。 */
export class WorkflowRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** owner が所有するワークフローを更新日時降順で返す。query があれば name/description を LIKE 検索。 */
  async list(owner: string, query?: string): Promise<WorkflowRecord[]> {
    const trimmed = query?.trim();
    if (trimmed) {
      const rows = await this.db.query<WorkflowRow>(
        `SELECT * FROM workflows
         WHERE owner = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
         ORDER BY updated_at DESC`,
        [owner, likeParam(trimmed), likeParam(trimmed)],
      );
      return rows.map(rowToWorkflow);
    }
    const rows = await this.db.query<WorkflowRow>(
      'SELECT * FROM workflows WHERE owner = ? ORDER BY updated_at DESC',
      [owner],
    );
    return rows.map(rowToWorkflow);
  }

  async get(owner: string, id: string): Promise<WorkflowRecord | undefined> {
    const rows = await this.db.query<WorkflowRow>(
      'SELECT * FROM workflows WHERE id = ? AND owner = ?',
      [id, owner],
    );
    return rows[0] ? rowToWorkflow(rows[0]) : undefined;
  }

  async getById(id: string): Promise<WorkflowRecord | undefined> {
    const rows = await this.db.query<WorkflowRow>('SELECT * FROM workflows WHERE id = ?', [id]);
    return rows[0] ? rowToWorkflow(rows[0]) : undefined;
  }

  /** cron が設定され enabled な全ワークフロー (スケジューラー tick 用)。 */
  async listAllEnabled(): Promise<WorkflowRecord[]> {
    const rows = await this.db.query<WorkflowRow>(
      'SELECT * FROM workflows WHERE enabled = 1 AND cron IS NOT NULL ORDER BY id',
    );
    return rows.map(rowToWorkflow);
  }

  async create(owner: string, input: CreateWorkflowInput): Promise<WorkflowRecord> {
    const nowIso = new Date().toISOString();
    const retry = input.retry ?? retryPolicySchema.parse({});
    const record: WorkflowRecord = {
      id: newId('wfl_'),
      owner,
      name: input.name,
      description: input.description ?? '',
      stages: input.stages,
      datasourceId: input.datasourceId,
      cron: input.cron ?? null,
      enabled: input.enabled ?? true,
      retry,
      principalSnapshot: input.principalSnapshot ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.db.run(
      `INSERT INTO workflows
         (id, name, description, stages, datasource_id, cron, enabled, retry,
          owner, principal_snapshot, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.name,
        record.description,
        serializeStages(record.stages),
        record.datasourceId,
        record.cron,
        record.enabled ? 1 : 0,
        serializeRetry(record.retry),
        record.owner,
        serializePrincipalSnapshot(record.principalSnapshot),
        record.createdAt,
        record.updatedAt,
      ],
    );
    return record;
  }

  async update(
    owner: string,
    id: string,
    input: UpdateWorkflowInput,
  ): Promise<WorkflowRecord | undefined> {
    const existing = await this.get(owner, id);
    if (!existing) return undefined;
    const merged: WorkflowRecord = {
      ...existing,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      stages: input.stages ?? existing.stages,
      datasourceId: input.datasourceId ?? existing.datasourceId,
      cron: input.cron !== undefined ? input.cron : existing.cron,
      enabled: input.enabled ?? existing.enabled,
      retry: input.retry ?? existing.retry,
      principalSnapshot:
        input.principalSnapshot !== undefined
          ? input.principalSnapshot
          : existing.principalSnapshot,
      updatedAt: new Date().toISOString(),
    };
    await this.db.run(
      `UPDATE workflows SET
         name = ?, description = ?, stages = ?, datasource_id = ?, cron = ?, enabled = ?,
         retry = ?, principal_snapshot = ?, updated_at = ?
       WHERE id = ? AND owner = ?`,
      [
        merged.name,
        merged.description,
        serializeStages(merged.stages),
        merged.datasourceId,
        merged.cron,
        merged.enabled ? 1 : 0,
        serializeRetry(merged.retry),
        serializePrincipalSnapshot(merged.principalSnapshot),
        merged.updatedAt,
        id,
        owner,
      ],
    );
    return merged;
  }

  /** ワークフロー本体と関連する run/step_runs を 1 transaction で削除し、result 削除 outbox も登録する。 */
  async delete(owner: string, id: string): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx.query<{ id: string }>(
        'DELETE FROM workflows WHERE id = ? AND owner = ? RETURNING id',
        [id, owner],
      );
      if (deleted.length === 0) return false;
      const resultRows = await tx.query<{ result_object_key: string | null }>(
        `DELETE FROM workflow_step_runs
         WHERE workflow_id = ?
         RETURNING result_object_key`,
        [id],
      );
      await new ResultObjectDeletionRepository(tx).enqueue(
        resultRows.flatMap((row) =>
          row.result_object_key === null ? [] : [row.result_object_key],
        ),
        new Date().toISOString(),
      );
      await tx.run('DELETE FROM workflow_runs WHERE workflow_id = ?', [id]);
      return true;
    });
  }
}

// ---------------------------------------------------------------------------
// Workflow runs
// ---------------------------------------------------------------------------

interface WorkflowRunRow {
  id: string;
  workflow_id: string;
  owner: string;
  status: string;
  trigger: string;
  scheduled_for: string;
  started_at: string;
  finished_at: string | null;
  elapsed_ms: number | null;
}

interface WorkflowStepRunRow {
  id: string;
  run_id: string;
  workflow_id: string;
  step_id: string;
  stage_index: number;
  name: string;
  datasource_id: string;
  status: string;
  attempt: number;
  row_count: number | null;
  elapsed_ms: number | null;
  error_type: string | null;
  error_message: string | null;
  result_object_key: string | null;
  result_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface WorkflowRunRecord extends WorkflowRunSummary {
  workflowId: string;
  owner: string;
}

export interface WorkflowRunDetail extends WorkflowRunRecord {
  steps: WorkflowStepRun[];
}

export interface FinishWorkflowRunInput {
  status: WorkflowRunStatus;
  finishedAt: string;
  elapsedMs: number;
}

export interface FinishWorkflowStepInput {
  status: WorkflowStepRunStatus;
  attempt: number;
  rowCount?: number | null;
  elapsedMs?: number | null;
  errorType?: string | null;
  errorMessage?: string | null;
  resultObjectKey?: string | null;
  resultExpiresAt?: string | null;
  finishedAt: string;
}

export interface ExpiredWorkflowStepResult {
  id: string;
  resultObjectKey: string;
  resultExpiresAt: string;
}

/** 同一ワークフローの running claim が既に存在する。 */
export class WorkflowRunClaimConflictError extends Error {
  constructor(readonly workflowId: string) {
    super(`A run is already in progress for workflow ${workflowId}`);
    this.name = 'WorkflowRunClaimConflictError';
  }
}

/** run 開始前に対象 workflow が削除済みだったことを表す。 */
export class WorkflowRunTargetNotFoundError extends Error {
  constructor(readonly workflowId: string) {
    super(`Workflow ${workflowId} no longer exists`);
    this.name = 'WorkflowRunTargetNotFoundError';
  }
}

function rowToStepRun(row: WorkflowStepRunRow): WorkflowStepRun {
  return workflowStepRunSchema.parse({
    id: row.id,
    stepId: row.step_id,
    stageIndex: Number(row.stage_index),
    name: row.name,
    datasourceId: row.datasource_id,
    status: row.status,
    attempt: Number(row.attempt),
    rowCount: row.row_count === null ? null : Number(row.row_count),
    elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    errorType: row.error_type ?? null,
    errorMessage: row.error_message ?? null,
    resultAvailable: row.result_object_key !== null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
  });
}

function countSteps(rows: WorkflowStepRunRow[]): WorkflowRunSummary['stepCounts'] {
  const counts = { total: rows.length, success: 0, failed: 0, blocked: 0, skipped: 0 };
  for (const row of rows) {
    if (row.status === 'success') counts.success += 1;
    else if (row.status === 'failed') counts.failed += 1;
    else if (row.status === 'blocked') counts.blocked += 1;
    else if (row.status === 'skipped') counts.skipped += 1;
  }
  return counts;
}

function rowToRunSummary(row: WorkflowRunRow, stepRows: WorkflowStepRunRow[]): WorkflowRunSummary {
  return workflowRunSummarySchema.parse({
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
    elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    stepCounts: countSteps(stepRows),
  });
}

/** ワークフロー実行の永続化。 */
export class WorkflowRunRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly retention: number,
  ) {}

  /** run 行と全ステップ行 (pending) を 1 トランザクションで作成する。 */
  async startRun(
    workflow: WorkflowRecord,
    trigger: 'manual' | 'cron',
    scheduledFor: string,
    startedAt: string,
  ): Promise<string> {
    const runId = newId('wfr_');
    await this.db.transaction(async (tx) => {
      // delete と同じ workflow row の write lock を取り、古い WorkflowRecord からの再生成を防ぐ。
      const targets = await tx.query<{ id: string }>(
        'UPDATE workflows SET id = id WHERE id = ? AND owner = ? RETURNING id',
        [workflow.id, workflow.owner],
      );
      if (targets.length === 0) {
        throw new WorkflowRunTargetNotFoundError(workflow.id);
      }
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO workflow_runs
           (id, workflow_id, owner, status, trigger, scheduled_for, started_at)
         VALUES (?, ?, ?, 'running', ?, ?, ?)
         ON CONFLICT (workflow_id) WHERE status = 'running' DO NOTHING
         RETURNING id`,
        [runId, workflow.id, workflow.owner, trigger, scheduledFor, startedAt],
      );
      if (inserted.length === 0) {
        throw new WorkflowRunClaimConflictError(workflow.id);
      }
      const stepParams: SqlParam[] = [];
      const placeholders: string[] = [];
      for (let stageIndex = 0; stageIndex < workflow.stages.length; stageIndex += 1) {
        const stage = workflow.stages[stageIndex]!;
        for (const step of stage.steps) {
          const stepRunId = newId('wfs_');
          placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, 0, ?)');
          stepParams.push(
            stepRunId,
            runId,
            workflow.id,
            step.id,
            stageIndex,
            step.name,
            step.datasourceId ?? workflow.datasourceId,
            'pending',
            startedAt,
          );
        }
      }
      if (placeholders.length > 0) {
        await tx.run(
          `INSERT INTO workflow_step_runs
             (id, run_id, workflow_id, step_id, stage_index, name, datasource_id,
              status, attempt, started_at)
           VALUES ${placeholders.join(', ')}`,
          stepParams,
        );
      }
    });
    return runId;
  }

  async markStepRunning(stepRunId: string, startedAt: string): Promise<void> {
    await this.db.run(
      `UPDATE workflow_step_runs SET status = 'running', started_at = ? WHERE id = ?`,
      [startedAt, stepRunId],
    );
  }

  async finishStep(stepRunId: string, input: FinishWorkflowStepInput): Promise<void> {
    await this.db.transaction(async (tx) => {
      const updated = await tx.query<{ id: string }>(
        `UPDATE workflow_step_runs SET
           status = ?, attempt = ?, row_count = ?, elapsed_ms = ?,
           error_type = ?, error_message = ?, result_object_key = ?, result_expires_at = ?,
           finished_at = ?
         WHERE id = ?
         RETURNING id`,
        [
          input.status,
          input.attempt,
          input.rowCount ?? null,
          input.elapsedMs ?? null,
          input.errorType ?? null,
          input.errorMessage ?? null,
          input.resultObjectKey ?? null,
          input.resultExpiresAt ?? null,
          input.finishedAt,
          stepRunId,
        ],
      );
      if (updated.length === 0 && input.resultObjectKey) {
        // workflow 削除が先に step row を消した場合も、完成済み object の参照を失わない。
        await new ResultObjectDeletionRepository(tx).enqueue(
          [input.resultObjectKey],
          input.finishedAt,
        );
      }
    });
  }

  async skipRemaining(runId: string, fromStageIndex: number, finishedAt: string): Promise<void> {
    await this.db.run(
      `UPDATE workflow_step_runs SET status = 'skipped', finished_at = ?
       WHERE run_id = ? AND status = 'pending' AND stage_index >= ?`,
      [finishedAt, runId, fromStageIndex],
    );
  }

  async finishRun(runId: string, workflowId: string, input: FinishWorkflowRunInput): Promise<void> {
    await this.db.run(
      `UPDATE workflow_runs SET status = ?, finished_at = ?, elapsed_ms = ? WHERE id = ?`,
      [input.status, input.finishedAt, input.elapsedMs, runId],
    );
    await this.prune(workflowId);
  }

  async getRun(runId: string): Promise<WorkflowRunDetail | undefined> {
    const rows = await this.db.query<WorkflowRunRow>('SELECT * FROM workflow_runs WHERE id = ?', [
      runId,
    ]);
    const row = rows[0];
    if (!row) return undefined;
    const stepRows = await this.db.query<WorkflowStepRunRow>(
      `SELECT * FROM workflow_step_runs WHERE run_id = ?
       ORDER BY stage_index ASC, step_id ASC`,
      [runId],
    );
    const summary = rowToRunSummary(row, stepRows);
    return {
      ...summary,
      workflowId: row.workflow_id,
      owner: row.owner,
      steps: stepRows.map(rowToStepRun),
    };
  }

  async listRuns(workflowId: string, limit: number): Promise<WorkflowRunRecord[]> {
    const runRows = await this.db.query<WorkflowRunRow>(
      `SELECT * FROM workflow_runs WHERE workflow_id = ?
       ORDER BY started_at DESC, id DESC LIMIT ?`,
      [workflowId, limit],
    );
    const stepRowsByRun = await this.loadStepRowsByRun(runRows.map((row) => row.id));
    return runRows.map((row) => ({
      ...rowToRunSummary(row, stepRowsByRun.get(row.id) ?? []),
      workflowId: row.workflow_id,
      owner: row.owner,
    }));
  }

  async latest(workflowId: string): Promise<WorkflowRunRecord | undefined> {
    const rows = await this.listRuns(workflowId, 1);
    return rows[0];
  }

  /** 複数ワークフローの直近 run と step 集計を500 idごとの固定回数で取得する。 */
  async latestMany(workflowIds: readonly string[]): Promise<Map<string, WorkflowRunRecord>> {
    if (workflowIds.length === 0) return new Map();
    const runRows: WorkflowRunRow[] = [];
    for (let offset = 0; offset < workflowIds.length; offset += SQL_ID_CHUNK_SIZE) {
      const chunk = workflowIds.slice(offset, offset + SQL_ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      runRows.push(
        ...(await this.db.query<WorkflowRunRow>(
          `SELECT * FROM (
             SELECT workflow_runs.*,
                    ROW_NUMBER() OVER (
                      PARTITION BY workflow_id ORDER BY started_at DESC, id DESC
                    ) AS run_rank
             FROM workflow_runs
             WHERE workflow_id IN (${placeholders})
           ) ranked
           WHERE run_rank = 1`,
          chunk,
        )),
      );
    }
    const stepRowsByRun = await this.loadStepRowsByRun(runRows.map((row) => row.id));
    return new Map(
      runRows.map((row) => [
        row.workflow_id,
        {
          ...rowToRunSummary(row, stepRowsByRun.get(row.id) ?? []),
          workflowId: row.workflow_id,
          owner: row.owner,
        },
      ]),
    );
  }

  async hasRunning(workflowId: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      "SELECT id FROM workflow_runs WHERE workflow_id = ? AND status = 'running' LIMIT 1",
      [workflowId],
    );
    return rows.length > 0;
  }

  async abortOrphans(finishedAt: string): Promise<number> {
    const runs = await this.db.query<{ id: string }>(
      "UPDATE workflow_runs SET status = 'aborted', finished_at = ? WHERE status = 'running' RETURNING id",
      [finishedAt],
    );
    await this.db.run(
      "UPDATE workflow_step_runs SET status = 'aborted', finished_at = ? WHERE status = 'running'",
      [finishedAt],
    );
    if (runs.length > 0) {
      const ids = runs.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      await this.db.run(
        `UPDATE workflow_step_runs SET status = 'skipped', finished_at = ?
         WHERE status = 'pending' AND run_id IN (${placeholders})`,
        [finishedAt, ...ids],
      );
    }
    return runs.length;
  }

  async listExpiredResults(
    nowIso: string,
    options: {
      after?: { resultExpiresAt: string; id: string };
      limit?: number;
    } = {},
  ): Promise<ExpiredWorkflowStepResult[]> {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 1_000);
    const cursorWhere = options.after
      ? 'AND (result_expires_at > ? OR (result_expires_at = ? AND id > ?))'
      : '';
    const params: SqlParam[] = [nowIso];
    if (options.after) {
      params.push(options.after.resultExpiresAt, options.after.resultExpiresAt, options.after.id);
    }
    params.push(limit);
    const rows = await this.db.query<{
      id: string;
      result_object_key: string;
      result_expires_at: string;
    }>(
      `SELECT id, result_object_key, result_expires_at FROM workflow_step_runs
       WHERE result_object_key IS NOT NULL AND result_expires_at IS NOT NULL
         AND result_expires_at <= ? ${cursorWhere}
       ORDER BY result_expires_at ASC, id ASC
       LIMIT ?`,
      params,
    );
    return rows.map((row) => ({
      id: row.id,
      resultObjectKey: row.result_object_key,
      resultExpiresAt: row.result_expires_at,
    }));
  }

  async clearResultObjects(keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const placeholders = keys.map(() => '?').join(', ');
    await this.db.run(
      `UPDATE workflow_step_runs
       SET result_object_key = NULL, result_expires_at = NULL
       WHERE result_object_key IN (${placeholders})`,
      keys,
    );
  }

  private async loadStepRowsByRun(
    runIds: readonly string[],
  ): Promise<Map<string, WorkflowStepRunRow[]>> {
    if (runIds.length === 0) return new Map();
    const grouped = new Map<string, WorkflowStepRunRow[]>();
    for (let offset = 0; offset < runIds.length; offset += SQL_ID_CHUNK_SIZE) {
      const chunk = runIds.slice(offset, offset + SQL_ID_CHUNK_SIZE);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await this.db.query<WorkflowStepRunRow>(
        `SELECT * FROM workflow_step_runs
         WHERE run_id IN (${placeholders})
         ORDER BY run_id ASC, stage_index ASC, step_id ASC`,
        chunk,
      );
      for (const row of rows) {
        const group = grouped.get(row.run_id);
        if (group) group.push(row);
        else grouped.set(row.run_id, [row]);
      }
    }
    return grouped;
  }

  async getStepRun(
    runId: string,
    stepRunId: string,
  ): Promise<
    | (WorkflowStepRun & {
        owner: string;
        resultObjectKey: string | null;
        resultExpiresAt: string | null;
      })
    | undefined
  > {
    const rows = await this.db.query<WorkflowStepRunRow & { owner: string }>(
      `SELECT s.*, r.owner
       FROM workflow_step_runs s
       JOIN workflow_runs r ON r.id = s.run_id
       WHERE s.run_id = ? AND s.id = ?`,
      [runId, stepRunId],
    );
    const row = rows[0];
    if (!row) return undefined;
    return {
      ...rowToStepRun(row),
      owner: row.owner,
      resultObjectKey: row.result_object_key ?? null,
      resultExpiresAt: row.result_expires_at ?? null,
    };
  }

  private async prune(workflowId: string): Promise<void> {
    if (this.retention <= 0) return;
    await this.db.transaction(async (tx) => {
      const oldRuns = await tx.query<{ id: string }>(
        `SELECT id FROM workflow_runs WHERE workflow_id = ?
           AND id NOT IN (
             SELECT id FROM workflow_runs WHERE workflow_id = ?
             ORDER BY started_at DESC, id DESC LIMIT ?
           )`,
        [workflowId, workflowId, this.retention],
      );
      if (oldRuns.length === 0) return;
      const ids = oldRuns.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      const resultRows = await tx.query<{ result_object_key: string }>(
        `SELECT result_object_key FROM workflow_step_runs
         WHERE run_id IN (${placeholders}) AND result_object_key IS NOT NULL`,
        ids,
      );
      await new ResultObjectDeletionRepository(tx).enqueue(
        resultRows.map((row) => row.result_object_key),
        new Date().toISOString(),
      );
      await tx.run(`DELETE FROM workflow_step_runs WHERE run_id IN (${placeholders})`, ids);
      await tx.run(`DELETE FROM workflow_runs WHERE id IN (${placeholders})`, ids);
    });
  }
}

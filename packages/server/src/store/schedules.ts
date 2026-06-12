import type { RetryPolicy, ScheduleRunStatus, ScheduleRunSummary } from '@hubble/contracts';
import { retryPolicySchema } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { newId } from '../util/id';

/**
 * A schedule as stored, without the response-only derived fields (`nextRunAt`,
 * `lastRun`). The route layer enriches this into the contract `Schedule`.
 */
export interface ScheduleRecord {
  id: string;
  owner: string;
  name: string;
  statement: string;
  catalog: string | null;
  schema: string | null;
  cron: string;
  enabled: boolean;
  retry: RetryPolicy;
  createdAt: string;
  updatedAt: string;
}

/** Fields a caller may set when creating a schedule. */
export interface CreateScheduleInput {
  name: string;
  statement: string;
  catalog?: string | null;
  schema?: string | null;
  cron: string;
  enabled?: boolean;
  retry?: RetryPolicy;
}

/** Partial update; only provided keys are applied. */
export interface UpdateScheduleInput {
  name?: string;
  statement?: string;
  catalog?: string | null;
  schema?: string | null;
  cron?: string;
  enabled?: boolean;
  retry?: RetryPolicy;
}

interface ScheduleRow {
  id: string;
  owner: string;
  name: string;
  statement: string;
  catalog: string | null;
  schema: string | null;
  cron: string;
  enabled: number;
  retry_max_attempts: number;
  retry_backoff_seconds: number;
  retry_backoff_multiplier: number;
  created_at: string;
  updated_at: string;
}

function rowToSchedule(row: ScheduleRow): ScheduleRecord {
  return {
    id: row.id,
    owner: row.owner,
    name: row.name,
    statement: row.statement,
    catalog: row.catalog ?? null,
    schema: row.schema ?? null,
    cron: row.cron,
    // SQLite stores 0/1; PostgreSQL's INTEGER round-trips the same value.
    enabled: Number(row.enabled) !== 0,
    retry: retryPolicySchema.parse({
      maxAttempts: Number(row.retry_max_attempts),
      backoffSeconds: Number(row.retry_backoff_seconds),
      backoffMultiplier: Number(row.retry_backoff_multiplier),
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * CRUD for schedules (Query Scheduling feature). Every operation is scoped to an
 * `owner` principal (design.md §11). The unscoped `listAllEnabled` is used by
 * the in-process scheduler tick to find due work across all owners.
 */
export class ScheduleRepository {
  constructor(private readonly db: SqlDatabase) {}

  async list(owner: string): Promise<ScheduleRecord[]> {
    const rows = await this.db.query<ScheduleRow>(
      'SELECT * FROM schedules WHERE owner = ? ORDER BY updated_at DESC',
      [owner],
    );
    return rows.map(rowToSchedule);
  }

  async get(owner: string, id: string): Promise<ScheduleRecord | undefined> {
    const rows = await this.db.query<ScheduleRow>(
      'SELECT * FROM schedules WHERE id = ? AND owner = ?',
      [id, owner],
    );
    return rows[0] ? rowToSchedule(rows[0]) : undefined;
  }

  /** Fetch a schedule by id without owner scoping (scheduler internals only). */
  async getById(id: string): Promise<ScheduleRecord | undefined> {
    const rows = await this.db.query<ScheduleRow>('SELECT * FROM schedules WHERE id = ?', [id]);
    return rows[0] ? rowToSchedule(rows[0]) : undefined;
  }

  /** All enabled schedules across every owner (scheduler tick). */
  async listAllEnabled(): Promise<ScheduleRecord[]> {
    const rows = await this.db.query<ScheduleRow>(
      'SELECT * FROM schedules WHERE enabled = 1 ORDER BY id',
    );
    return rows.map(rowToSchedule);
  }

  async create(owner: string, input: CreateScheduleInput): Promise<ScheduleRecord> {
    const nowIso = new Date().toISOString();
    const retry = input.retry ?? retryPolicySchema.parse({});
    const record: ScheduleRecord = {
      id: newId('sch_'),
      owner,
      name: input.name,
      statement: input.statement,
      catalog: input.catalog ?? null,
      schema: input.schema ?? null,
      cron: input.cron,
      enabled: input.enabled ?? true,
      retry,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.db.run(
      `INSERT INTO schedules
         (id, owner, name, statement, catalog, schema, cron, enabled,
          retry_max_attempts, retry_backoff_seconds, retry_backoff_multiplier,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insertParams(record),
    );
    return record;
  }

  async update(
    owner: string,
    id: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleRecord | undefined> {
    const existing = await this.get(owner, id);
    if (!existing) return undefined;
    const merged: ScheduleRecord = {
      ...existing,
      name: input.name ?? existing.name,
      statement: input.statement ?? existing.statement,
      catalog: input.catalog !== undefined ? input.catalog : existing.catalog,
      schema: input.schema !== undefined ? input.schema : existing.schema,
      cron: input.cron ?? existing.cron,
      enabled: input.enabled ?? existing.enabled,
      retry: input.retry ?? existing.retry,
      updatedAt: new Date().toISOString(),
    };
    await this.db.run(
      `UPDATE schedules SET
         name = ?, statement = ?, catalog = ?, schema = ?, cron = ?, enabled = ?,
         retry_max_attempts = ?, retry_backoff_seconds = ?, retry_backoff_multiplier = ?,
         updated_at = ?
       WHERE id = ? AND owner = ?`,
      [
        merged.name,
        merged.statement,
        merged.catalog,
        merged.schema,
        merged.cron,
        merged.enabled ? 1 : 0,
        merged.retry.maxAttempts,
        merged.retry.backoffSeconds,
        merged.retry.backoffMultiplier,
        merged.updatedAt,
        id,
        owner,
      ],
    );
    return merged;
  }

  /** Delete a schedule and all of its runs. Returns true if it existed. */
  async delete(owner: string, id: string): Promise<boolean> {
    const deleted = await this.db.query<{ id: string }>(
      'DELETE FROM schedules WHERE id = ? AND owner = ? RETURNING id',
      [id, owner],
    );
    if (deleted.length === 0) return false;
    // App-side cascade (no FK ON DELETE; see migration 0003).
    await this.db.run('DELETE FROM schedule_runs WHERE schedule_id = ?', [id]);
    return true;
  }
}

function insertParams(s: ScheduleRecord): SqlParam[] {
  return [
    s.id,
    s.owner,
    s.name,
    s.statement,
    s.catalog,
    s.schema,
    s.cron,
    s.enabled ? 1 : 0,
    s.retry.maxAttempts,
    s.retry.backoffSeconds,
    s.retry.backoffMultiplier,
    s.createdAt,
    s.updatedAt,
  ];
}

// ---------------------------------------------------------------------------
// Schedule runs
// ---------------------------------------------------------------------------

interface ScheduleRunRow {
  id: string;
  schedule_id: string;
  owner: string;
  status: string;
  attempt: number;
  trino_query_id: string | null;
  error_type: string | null;
  error_message: string | null;
  row_count: number | null;
  elapsed_ms: number | null;
  scheduled_for: string;
  started_at: string;
  finished_at: string | null;
}

/** Fields recorded when a run starts. */
export interface StartRunInput {
  scheduleId: string;
  owner: string;
  scheduledFor: string;
  startedAt: string;
}

/** Fields recorded when a run finishes (one row per run). */
export interface FinishRunInput {
  status: ScheduleRunStatus;
  attempt: number;
  trinoQueryId?: string | null;
  errorType?: string | null;
  errorMessage?: string | null;
  rowCount?: number | null;
  elapsedMs?: number | null;
  finishedAt: string;
}

export interface ScheduleRunRecord extends ScheduleRunSummary {
  scheduleId: string;
  owner: string;
}

function rowToRun(row: ScheduleRunRow): ScheduleRunRecord {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    owner: row.owner,
    status: row.status as ScheduleRunStatus,
    attempt: Number(row.attempt),
    trinoQueryId: row.trino_query_id ?? null,
    errorType: row.error_type ?? null,
    errorMessage: row.error_message ?? null,
    rowCount: row.row_count === null ? null : Number(row.row_count),
    elapsedMs: row.elapsed_ms === null ? null : Number(row.elapsed_ms),
    scheduledFor: row.scheduled_for,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? null,
  };
}

/**
 * Persistence for individual scheduled runs (Query Scheduling feature). A run is
 * inserted in `running` state when it starts and updated to its terminal state
 * when it finishes; older rows beyond the retention cap are pruned per schedule.
 */
export class ScheduleRunRepository {
  constructor(
    private readonly db: SqlDatabase,
    /** Per-schedule cap on retained run rows. */
    private readonly retention: number,
  ) {}

  /** Insert a `running` row and return its generated id. */
  async start(input: StartRunInput): Promise<string> {
    const id = newId('run_');
    await this.db.run(
      `INSERT INTO schedule_runs
         (id, schedule_id, owner, status, attempt, scheduled_for, started_at)
       VALUES (?, ?, ?, 'running', 0, ?, ?)`,
      [id, input.scheduleId, input.owner, input.scheduledFor, input.startedAt],
    );
    return id;
  }

  /** Update a run to its terminal state, then prune old rows for its schedule. */
  async finish(runId: string, scheduleId: string, input: FinishRunInput): Promise<void> {
    await this.db.run(
      `UPDATE schedule_runs SET
         status = ?, attempt = ?, trino_query_id = ?, error_type = ?, error_message = ?,
         row_count = ?, elapsed_ms = ?, finished_at = ?
       WHERE id = ?`,
      [
        input.status,
        input.attempt,
        input.trinoQueryId ?? null,
        input.errorType ?? null,
        input.errorMessage ?? null,
        input.rowCount ?? null,
        input.elapsedMs ?? null,
        input.finishedAt,
        runId,
      ],
    );
    await this.prune(scheduleId);
  }

  /** Most recent runs for a schedule, newest first. */
  async list(scheduleId: string, limit: number): Promise<ScheduleRunRecord[]> {
    const rows = await this.db.query<ScheduleRunRow>(
      `SELECT * FROM schedule_runs WHERE schedule_id = ?
       ORDER BY started_at DESC, id DESC LIMIT ?`,
      [scheduleId, limit],
    );
    return rows.map(rowToRun);
  }

  /** The single most recent run for a schedule, or undefined. */
  async latest(scheduleId: string): Promise<ScheduleRunRecord | undefined> {
    const rows = await this.list(scheduleId, 1);
    return rows[0];
  }

  /** True if a run for this schedule is currently in `running` state. */
  async hasRunning(scheduleId: string): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      "SELECT id FROM schedule_runs WHERE schedule_id = ? AND status = 'running' LIMIT 1",
      [scheduleId],
    );
    return rows.length > 0;
  }

  /**
   * Crash recovery: mark any run still `running` (left over from a previous
   * process that exited mid-run) as `aborted`. Returns the number updated.
   */
  async abortOrphans(finishedAt: string): Promise<number> {
    const rows = await this.db.query<{ id: string }>(
      "UPDATE schedule_runs SET status = 'aborted', finished_at = ? WHERE status = 'running' RETURNING id",
      [finishedAt],
    );
    return rows.length;
  }

  /**
   * Keep only the newest `retention` runs for a schedule; delete the rest. The
   * subquery selects the ids to keep (works on both SQLite and PostgreSQL).
   */
  private async prune(scheduleId: string): Promise<void> {
    if (this.retention <= 0) return;
    await this.db.run(
      `DELETE FROM schedule_runs
       WHERE schedule_id = ?
         AND id NOT IN (
           SELECT id FROM schedule_runs WHERE schedule_id = ?
           ORDER BY started_at DESC, id DESC LIMIT ?
         )`,
      [scheduleId, scheduleId, this.retention],
    );
  }
}

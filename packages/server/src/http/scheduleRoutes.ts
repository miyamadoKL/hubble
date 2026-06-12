import { Hono } from 'hono';
import {
  createScheduleRequestSchema,
  updateScheduleRequestSchema,
  type Schedule,
  type ScheduleRunSummary,
} from '@hubble/contracts';
import type { Services } from '../services';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import type { ScheduleRecord, ScheduleRunRecord } from '../store/schedules';
import { nextRunIso } from '../schedule/cron';
import type { ValidationResult } from '../schedule/validator';
import { intParam, parseJsonBody } from './validate';

type App = Hono<{ Variables: AuthVariables }>;

/** Map a stored run record to the contract run summary. */
function toRunSummary(run: ScheduleRunRecord): ScheduleRunSummary {
  return {
    id: run.id,
    status: run.status,
    attempt: run.attempt,
    trinoQueryId: run.trinoQueryId,
    errorType: run.errorType,
    errorMessage: run.errorMessage,
    rowCount: run.rowCount,
    elapsedMs: run.elapsedMs,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

/** Enrich a stored schedule into the contract `Schedule` (nextRunAt + lastRun). */
async function toSchedule(services: Services, record: ScheduleRecord): Promise<Schedule> {
  const latest = await services.scheduleRuns.latest(record.id);
  return {
    id: record.id,
    name: record.name,
    statement: record.statement,
    catalog: record.catalog,
    schema: record.schema,
    cron: record.cron,
    enabled: record.enabled,
    retry: record.retry,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    // Computed from "now": disabled schedules have no next run.
    nextRunAt: record.enabled ? nextRunIso(record.cron, new Date()) : null,
    lastRun: latest ? toRunSummary(latest) : null,
  };
}

/**
 * Turn a non-OK validation into a thrown AppError, or return for an `ok`/
 * `unavailable` result (create/update are lenient when Trino is unreachable —
 * the statement is re-validated at run time). A `user_error` becomes a 400
 * VALIDATION_ERROR carrying Trino's message + line/column.
 */
function assertValidationAllowsWrite(result: ValidationResult): void {
  if (result.ok) return;
  if (result.kind === 'unavailable') return; // lenient: allow, re-checked at run time
  // Deterministic statement error: reject the write.
  const detail: Record<string, unknown> = { trinoMessage: result.message };
  if (result.line !== undefined) detail.line = result.line;
  if (result.column !== undefined) detail.column = result.column;
  throw new AppError(400, {
    code: 'VALIDATION_ERROR',
    message: `Statement failed validation: ${result.message}`,
    details: detail,
  });
}

/**
 * Schedule routes (Query Scheduling feature), mounted under `/api/schedules`.
 * Owner-scoped (design.md §11). Create/update validate the statement with
 * `EXPLAIN (TYPE VALIDATE)`; manual run + run history mirror the scheduler.
 */
export function scheduleRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  app.get('/', async (c) => {
    const owner = c.var.principal.user;
    const records = await services.schedules.list(owner);
    const schedules = await Promise.all(records.map((r) => toSchedule(services, r)));
    return c.json(schedules);
  });

  app.post('/', async (c) => {
    const owner = c.var.principal.user;
    const body = await parseJsonBody(c, createScheduleRequestSchema);
    const validation = await services.scheduleValidator.validate({
      statement: body.statement,
      catalog: body.catalog,
      schema: body.schema,
      principal: owner,
    });
    assertValidationAllowsWrite(validation);
    const record = await services.schedules.create(owner, body);
    return c.json(await toSchedule(services, record), 201);
  });

  app.get('/:id', async (c) => {
    const owner = c.var.principal.user;
    const record = await services.schedules.get(owner, c.req.param('id'));
    if (!record) throw AppError.notFound(`Schedule ${c.req.param('id')} not found`);
    return c.json(await toSchedule(services, record));
  });

  app.patch('/:id', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const existing = await services.schedules.get(owner, id);
    if (!existing) throw AppError.notFound(`Schedule ${id} not found`);
    const body = await parseJsonBody(c, updateScheduleRequestSchema);

    // Re-validate when the statement or its execution context changes.
    const statementChanges =
      body.statement !== undefined ||
      body.catalog !== undefined ||
      body.schema !== undefined ||
      body.cron !== undefined;
    if (statementChanges) {
      const validation = await services.scheduleValidator.validate({
        statement: body.statement ?? existing.statement,
        catalog: body.catalog !== undefined ? body.catalog : existing.catalog,
        schema: body.schema !== undefined ? body.schema : existing.schema,
        principal: owner,
      });
      assertValidationAllowsWrite(validation);
    }

    const updated = await services.schedules.update(owner, id, body);
    if (!updated) throw AppError.notFound(`Schedule ${id} not found`);
    return c.json(await toSchedule(services, updated));
  });

  app.delete('/:id', async (c) => {
    const owner = c.var.principal.user;
    const ok = await services.schedules.delete(owner, c.req.param('id'));
    if (!ok) throw AppError.notFound(`Schedule ${c.req.param('id')} not found`);
    return c.json({ ok: true });
  });

  app.post('/:id/run', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const record = await services.schedules.get(owner, id);
    if (!record) throw AppError.notFound(`Schedule ${id} not found`);
    try {
      const { runId } = await services.scheduler.runManual(record);
      return c.json({ runId }, 202);
    } catch {
      throw AppError.conflict(`A run is already in progress for schedule ${id}`);
    }
  });

  app.get('/:id/runs', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const record = await services.schedules.get(owner, id);
    if (!record) throw AppError.notFound(`Schedule ${id} not found`);
    const limit = Math.min(Math.max(intParam(c.req.query('limit'), 50), 1), 200);
    const runs = await services.scheduleRuns.list(id, limit);
    return c.json({ items: runs.map((r) => ({ ...toRunSummary(r), scheduleId: r.scheduleId })) });
  });

  return app;
}

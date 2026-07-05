/**
 * クエリワークフロー API ルーター (`/api/workflows` および `/api/workflow-runs`)。
 */
import { Hono } from 'hono';
import {
  createWorkflowRequestSchema,
  updateWorkflowRequestSchema,
  workflowRunSchema,
  workflowRunsResponseSchema,
  workflowStepResultPageSchema,
  type Workflow,
  type WorkflowRunSummary,
  type WorkflowStep,
} from '@hubble/contracts';
import type { Services } from '../services';
import { resolveEngine } from '../engine/resolve';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import type { Principal } from '../auth/principal';
import { requireDatasourceAccess, schedulePrincipalIdentity } from '../rbac/check';
import { resolveRoleForPrincipal } from '../rbac/resolve';
import { assertQueryWriteAllowed } from '../rbac/writeCheck';
import type { WorkflowRecord, WorkflowRunRecord } from '../store/workflows';
import { WorkflowRunInProgressError } from '../workflow/runner';
import { nextRunIso } from '../schedule/cron';
import { intParam, parseJsonBody } from './validate';
import { readPersistedRowsPage } from '../resultStore/jsonl';

type App = Hono<{ Variables: AuthVariables }>;

function toRunSummary(run: WorkflowRunRecord): WorkflowRunSummary {
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    scheduledFor: run.scheduledFor,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    elapsedMs: run.elapsedMs,
    stepCounts: run.stepCounts,
  };
}

async function toWorkflow(services: Services, record: WorkflowRecord): Promise<Workflow> {
  const latest = await services.workflowRuns.latest(record.id);
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    stages: record.stages,
    datasourceId: record.datasourceId,
    cron: record.cron,
    enabled: record.enabled,
    retry: record.retry,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nextRunAt: record.enabled && record.cron ? nextRunIso(record.cron, new Date()) : null,
    lastRun: latest ? toRunSummary(latest) : null,
  };
}

async function assertStepWritable(
  services: Services,
  principal: Principal,
  step: WorkflowStep,
  engine: ReturnType<typeof resolveEngine>['engine'],
): Promise<void> {
  const role = resolveRoleForPrincipal(services.rbac, principal);
  const ioExplain = engine.ioExplainExecution?.({
    statement: step.statement,
    catalog: step.catalog ?? undefined,
    schema: step.schema ?? undefined,
    principal: principal.user,
  });
  await assertQueryWriteAllowed({
    statement: step.statement,
    role,
    ioExplainClient: ioExplain?.client,
    ioExplainCtx: ioExplain?.ctx,
    ioExplainTimeoutMs: services.config.guard.estimateTimeoutMs,
  });
}

async function validateAllSteps(
  services: Services,
  owner: string,
  roleName: string,
  defaultDatasourceId: string,
  stages: WorkflowRecord['stages'],
  workflowDatasourceId: string,
): Promise<void> {
  for (const stage of stages) {
    for (const step of stage.steps) {
      const targetDatasourceId = step.datasourceId ?? workflowDatasourceId;
      const { engine } = resolveEngine(services.engines, targetDatasourceId, defaultDatasourceId);
      const validation = await engine.validate({
        statement: step.statement,
        catalog: step.catalog ?? null,
        schema: step.schema ?? null,
        principal: owner,
        roleName,
      });
      if (!validation.ok && validation.kind === 'user_error') {
        throw new AppError(400, {
          code: 'VALIDATION_ERROR',
          message: `Statement failed validation: ${validation.message}`,
          details: {
            stepId: step.id,
            stepName: step.name,
            message: validation.message,
            ...(validation.line !== undefined ? { line: validation.line } : {}),
            ...(validation.column !== undefined ? { column: validation.column } : {}),
          },
        });
      }
    }
  }
}

async function validateStepsWritable(
  services: Services,
  principal: Principal,
  stages: WorkflowRecord['stages'],
  workflowDatasourceId: string,
): Promise<void> {
  for (const stage of stages) {
    for (const step of stage.steps) {
      const stepDs = step.datasourceId ?? workflowDatasourceId;
      if (stepDs !== workflowDatasourceId) {
        requireDatasourceAccess(principal.role, stepDs);
      }
      const { engine } = resolveEngine(services.engines, stepDs, services.defaultDatasourceId);
      await assertStepWritable(services, principal, step, engine);
    }
  }
}

export function workflowRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  app.get('/', async (c) => {
    const owner = c.var.principal.user;
    const query = c.req.query('query');
    const records = await services.workflows.list(owner, query);
    return c.json(await Promise.all(records.map((r) => toWorkflow(services, r))));
  });

  app.post('/', async (c) => {
    const owner = c.var.principal.user;
    const body = await parseJsonBody(c, createWorkflowRequestSchema);
    const targetDatasourceId = body.datasourceId ?? services.defaultDatasourceId;
    requireDatasourceAccess(c.var.principal.role, targetDatasourceId);
    const { datasourceId } = resolveEngine(
      services.engines,
      body.datasourceId,
      services.defaultDatasourceId,
    );
    await validateAllSteps(
      services,
      owner,
      c.var.principal.role.name,
      services.defaultDatasourceId,
      body.stages,
      datasourceId,
    );
    await validateStepsWritable(services, c.var.principal, body.stages, datasourceId);
    const record = await services.workflows.create(owner, {
      name: body.name,
      description: body.description,
      stages: body.stages,
      datasourceId,
      cron: body.cron ?? null,
      enabled: body.enabled,
      retry: body.retry,
      principalSnapshot: c.var.principal,
    });
    return c.json(await toWorkflow(services, record), 201);
  });

  app.get('/:id', async (c) => {
    const owner = c.var.principal.user;
    const record = await services.workflows.get(owner, c.req.param('id'));
    if (!record) throw AppError.notFound(`Workflow ${c.req.param('id')} not found`);
    return c.json(await toWorkflow(services, record));
  });

  app.patch('/:id', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const existing = await services.workflows.get(owner, id);
    if (!existing) throw AppError.notFound(`Workflow ${id} not found`);
    const body = await parseJsonBody(c, updateWorkflowRequestSchema);
    const disableOnly = Object.keys(body).length === 1 && body.enabled === false;
    if (!disableOnly) {
      requireDatasourceAccess(c.var.principal.role, existing.datasourceId);
    }
    const targetDatasourceId = body.datasourceId ?? existing.datasourceId;
    const targetStages = body.stages ?? existing.stages;
    if ((body.stages !== undefined || body.datasourceId !== undefined) && !disableOnly) {
      if (targetDatasourceId !== existing.datasourceId) {
        requireDatasourceAccess(c.var.principal.role, targetDatasourceId);
      }
      await validateAllSteps(
        services,
        owner,
        c.var.principal.role.name,
        services.defaultDatasourceId,
        targetStages,
        targetDatasourceId,
      );
      await validateStepsWritable(services, c.var.principal, targetStages, targetDatasourceId);
    }
    const updated = await services.workflows.update(owner, id, {
      ...body,
      principalSnapshot: c.var.principal,
    });
    if (!updated) throw AppError.notFound(`Workflow ${id} not found`);
    return c.json(await toWorkflow(services, updated));
  });

  app.delete('/:id', async (c) => {
    const owner = c.var.principal.user;
    const ok = await services.workflows.delete(owner, c.req.param('id'));
    if (!ok) throw AppError.notFound(`Workflow ${c.req.param('id')} not found`);
    return c.json({ ok: true });
  });

  app.post('/:id/run', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const record = await services.workflows.get(owner, id);
    if (!record) throw AppError.notFound(`Workflow ${id} not found`);
    const ownerRole = resolveRoleForPrincipal(
      services.rbac,
      schedulePrincipalIdentity(owner, record.principalSnapshot),
    );
    requireDatasourceAccess(ownerRole, record.datasourceId);
    try {
      const { runId } = await services.workflowRunner.runManual(record);
      return c.json({ runId }, 202);
    } catch (err) {
      // 実行中エラーのみ 409 に変換する。DB 障害等それ以外の失敗はそのまま伝播させる。
      if (err instanceof WorkflowRunInProgressError) {
        throw AppError.conflict(`A run is already in progress for workflow ${id}`);
      }
      throw err;
    }
  });

  app.get('/:id/runs', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const record = await services.workflows.get(owner, id);
    if (!record) throw AppError.notFound(`Workflow ${id} not found`);
    const limit = Math.min(Math.max(intParam(c.req.query('limit'), 50), 1), 200);
    const runs = await services.workflowRuns.listRuns(id, limit);
    return c.json(workflowRunsResponseSchema.parse({ items: runs.map(toRunSummary) }));
  });

  return app;
}

export function workflowRunRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  app.get('/:runId', async (c) => {
    const owner = c.var.principal.user;
    const run = await services.workflowRuns.getRun(c.req.param('runId'));
    if (!run || run.owner !== owner) {
      throw AppError.notFound(`Workflow run ${c.req.param('runId')} not found`);
    }
    return c.json(
      workflowRunSchema.parse({
        id: run.id,
        workflowId: run.workflowId,
        status: run.status,
        trigger: run.trigger,
        scheduledFor: run.scheduledFor,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        elapsedMs: run.elapsedMs,
        stepCounts: run.stepCounts,
        steps: run.steps,
      }),
    );
  });

  app.get('/:runId/steps/:stepRunId/result', async (c) => {
    const owner = c.var.principal.user;
    const runId = c.req.param('runId');
    const stepRunId = c.req.param('stepRunId');
    const stepRun = await services.workflowRuns.getStepRun(runId, stepRunId);
    if (!stepRun || stepRun.owner !== owner) {
      throw AppError.notFound(`Workflow step result ${stepRunId} not found`);
    }
    requireDatasourceAccess(c.var.principal.role, stepRun.datasourceId);
    if (!services.resultStore.enabled) {
      throw new AppError(404, {
        code: 'RESULT_NOT_PERSISTED',
        message: 'Result persistence is disabled',
      });
    }
    if (!stepRun.resultObjectKey || !stepRun.resultExpiresAt) {
      throw AppError.notFound(`Workflow step result ${stepRunId} not found`);
    }
    if (new Date(stepRun.resultExpiresAt).getTime() <= Date.now()) {
      throw AppError.notFound(`Workflow step result ${stepRunId} not found`);
    }
    const offset = Math.max(intParam(c.req.query('offset'), 0), 0);
    const limit = Math.min(Math.max(intParam(c.req.query('limit'), 100), 1), 1000);
    const persisted = await readPersistedRowsPage(
      await services.resultStore.getStream(stepRun.resultObjectKey),
      offset,
      limit,
    );
    return c.json(
      workflowStepResultPageSchema.parse({
        columns: persisted.columns,
        rows: persisted.rows,
        totalRows: persisted.totalRows,
      }),
    );
  });

  return app;
}

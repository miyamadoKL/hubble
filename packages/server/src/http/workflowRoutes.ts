/**
 * クエリワークフロー API ルーター (`/api/workflows` および `/api/workflow-runs`)。
 */
import { Hono } from 'hono';
import { PassThrough, Readable } from 'node:stream';
import { stream } from 'hono/streaming';
import type { StreamingApi } from 'hono/utils/stream';
import { ZipFile } from 'yazl';
import {
  createWorkflowRequestSchema,
  updateWorkflowRequestSchema,
  workflowRunExportRequestSchema,
  workflowRunExportResponseSchema,
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
import {
  WorkflowRunTargetNotFoundError,
  type WorkflowRecord,
  type WorkflowRunRecord,
} from '../store/workflows';
import { WorkflowRunInProgressError } from '../workflow/runner';
import { nextRunIso } from '../schedule/cron';
import { intParam, parseJsonBody } from './validate';
import {
  readPersistedRowsPage,
  streamPersistedCsv,
  streamPersistedResultEvents,
} from '../resultStore/jsonl';
import { resolveWorkflowRunExport } from '../workflow/exportResolve';
import { writeXlsxWorkbook, XLSX_CONTENT_TYPE } from '../query/xlsx';
import { SheetsExporter, type SheetsClientFactory } from '../query/exportSheets';
import { JobAdmissionRejectedError } from '../schedule/admission';

type App = Hono<{ Variables: AuthVariables }>;

/** workflowRunRoutes のテスト用オプション。 */
export interface WorkflowRunRoutesOptions {
  sheetsClientFactory?: SheetsClientFactory;
}

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
      const { engine } = resolveEngine(services.engines, stepDs, services.defaultDatasourceId);
      await assertStepWritable(services, principal, step, engine);
    }
  }
}

/** 全 step の datasource 認可を同期的に検査する。 */
function assertAllStepDatasourcesAllowed(
  principal: Principal,
  stages: WorkflowRecord['stages'],
  workflowDatasourceId: string,
): void {
  for (const stage of stages) {
    for (const step of stage.steps) {
      requireDatasourceAccess(principal.role, step.datasourceId ?? workflowDatasourceId);
    }
  }
}

/** workflow の認可、構文検証、書き込み分類を決められた順序で実行する。 */
async function validateWorkflowSteps(
  services: Services,
  principal: Principal,
  stages: WorkflowRecord['stages'],
  workflowDatasourceId: string,
): Promise<void> {
  assertAllStepDatasourcesAllowed(principal, stages, workflowDatasourceId);
  await validateAllSteps(
    services,
    principal.user,
    principal.role.name,
    services.defaultDatasourceId,
    stages,
    workflowDatasourceId,
  );
  await validateStepsWritable(services, principal, stages, workflowDatasourceId);
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
    await validateWorkflowSteps(services, c.var.principal, body.stages, datasourceId);
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
      await validateWorkflowSteps(services, c.var.principal, targetStages, targetDatasourceId);
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
      if (err instanceof WorkflowRunTargetNotFoundError) {
        throw AppError.notFound(`Workflow ${id} not found`);
      }
      // 実行中エラーのみ 409 に変換する。DB 障害等それ以外の失敗はそのまま伝播させる。
      // 実行中と上限超過は409、shutdown中の受付終了は503へ変換する。
      if (err instanceof WorkflowRunInProgressError || err instanceof JobAdmissionRejectedError) {
        if (err instanceof JobAdmissionRejectedError && err.reason === 'closed') {
          throw new AppError(503, {
            code: 'SERVER_SHUTTING_DOWN',
            message: 'Scheduled job admission is closed',
          });
        }
        const message =
          err instanceof JobAdmissionRejectedError && err.reason === 'capacity'
            ? 'The scheduled job concurrency limit has been reached'
            : `A run is already in progress for workflow ${id}`;
        throw AppError.conflict(message);
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

export function workflowRunRoutes(services: Services, options: WorkflowRunRoutesOptions = {}): App {
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

  app.get('/:runId/download.zip', async (c) => {
    const runId = c.req.param('runId');
    const principal = c.var.principal;
    const resolved = await resolveWorkflowRunExport(services, runId, principal);

    await services.audit.record({
      actor: principal.user,
      action: 'csv.download',
      target: `workflow-run:${runId}`,
      detail: {
        outcome: 'allowed',
        workflowId: resolved.workflowId,
        runId,
        format: 'zip',
        stepCount: resolved.steps.length,
        steps: resolved.zipEntries.map(({ step, entryName }) => ({
          stepId: step.stepRunId,
          entry: entryName,
        })),
      },
    });

    c.header('Content-Type', 'application/zip');
    c.header('Content-Disposition', `attachment; filename="workflow-run-${runId}.zip"`);
    c.header('Cache-Control', 'no-store');

    return stream(c, async (rawStream) => {
      const ac = new AbortController();
      rawStream.onAbort(() => ac.abort());
      await pipeWorkflowZip(rawStream, services, resolved.zipEntries, ac.signal);
    });
  });

  app.get('/:runId/download.xlsx', async (c) => {
    const runId = c.req.param('runId');
    const principal = c.var.principal;
    const resolved = await resolveWorkflowRunExport(services, runId, principal);

    await services.audit.record({
      actor: principal.user,
      action: 'export.xlsx',
      target: `workflow-run:${runId}`,
      detail: {
        outcome: 'allowed',
        workflowId: resolved.workflowId,
        runId,
        format: 'xlsx',
        stepCount: resolved.steps.length,
        steps: resolved.sheets.map(({ step, name }) => ({
          stepId: step.stepRunId,
          sheet: name,
        })),
      },
    });

    c.header('Content-Type', XLSX_CONTENT_TYPE);
    c.header('Content-Disposition', `attachment; filename="workflow-run-${runId}.xlsx"`);
    c.header('Cache-Control', 'no-store');

    return stream(c, async (rawStream) => {
      const ac = new AbortController();
      rawStream.onAbort(() => ac.abort());
      const xlsx = new PassThrough();
      const sheets = await Promise.all(
        resolved.sheets.map(async ({ step, name }) => ({
          name,
          events: streamPersistedResultEvents(
            await services.resultStore.getStream(step.resultObjectKey),
          ),
        })),
      );
      const writer = writeXlsxWorkbook(sheets, xlsx).catch((err) => {
        xlsx.destroy(err instanceof Error ? err : new Error(String(err)));
        throw err;
      });
      await Promise.all([pipeNodeReadable(rawStream, xlsx, ac.signal), writer]);
    });
  });

  app.post('/:runId/export', async (c) => {
    const runId = c.req.param('runId');
    const principal = c.var.principal;
    const body = await parseJsonBody(c, workflowRunExportRequestSchema);
    const resolved = await resolveWorkflowRunExport(services, runId, principal);

    const workflow = await services.workflows.getById(resolved.workflowId);
    const title = workflow ? `${workflow.name} ${runId}` : runId;
    const exporter = new SheetsExporter(services.config.export.sheets, options.sheetsClientFactory);
    const sheets = await Promise.all(
      resolved.sheets.map(async ({ step, name }) => ({
        name,
        events: streamPersistedResultEvents(
          await services.resultStore.getStream(step.resultObjectKey),
        ),
      })),
    );
    const response = await exporter.exportMultiSheet({
      title,
      email: principal.email,
      sheets,
    });

    await services.audit.record({
      actor: principal.user,
      action: 'export.sheets',
      target: `workflow-run:${runId}`,
      detail: {
        outcome: 'allowed',
        workflowId: resolved.workflowId,
        runId,
        spreadsheetId: response.spreadsheetId,
        stepCount: resolved.steps.length,
        steps: resolved.sheets.map(({ step, name }) => ({
          stepId: step.stepRunId,
          sheet: name,
        })),
      },
    });

    return c.json(
      workflowRunExportResponseSchema.parse({
        destination: body.destination,
        spreadsheetId: response.spreadsheetId,
        url: response.url,
      }),
    );
  });

  return app;
}

/** 永続化済み CSV を複数エントリの zip として HTTP レスポンスへ流す。 */
async function pipeWorkflowZip(
  out: StreamingApi,
  services: Services,
  entries: ReadonlyArray<{ step: { resultObjectKey: string }; entryName: string }>,
  signal: AbortSignal,
): Promise<void> {
  const zip = new ZipFile();
  const sources: Readable[] = [];

  for (const entry of entries) {
    const csv = streamPersistedCsv(
      await services.resultStore.getStream(entry.step.resultObjectKey),
    );
    const source = Readable.from(csvBytes(csv, signal));
    sources.push(source);
    zip.addReadStream(source, entry.entryName, { compress: true, mtime: new Date(0) });
  }
  zip.end();

  try {
    for await (const chunk of zip.outputStream as AsyncIterable<Buffer>) {
      if (signal.aborted) break;
      await out.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  } finally {
    if (signal.aborted) {
      for (const source of sources) source.destroy();
    }
  }
}

/** UTF-8 encode each CSV text chunk for yazl, stopping early on abort. */
async function* csvBytes(csv: AsyncGenerator<string>, signal: AbortSignal): AsyncGenerator<Buffer> {
  const encoder = new TextEncoder();
  for await (const chunk of csv) {
    if (signal.aborted) return;
    yield Buffer.from(encoder.encode(chunk));
  }
}

/** Node.js Readable を Hono StreamingApi へポンプする。 */
async function pipeNodeReadable(
  rawStream: StreamingApi,
  source: Readable,
  signal: AbortSignal,
): Promise<void> {
  try {
    for await (const chunk of source) {
      if (signal.aborted) break;
      const buffer =
        chunk instanceof Uint8Array
          ? chunk
          : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk));
      await rawStream.write(buffer);
    }
  } finally {
    if (signal.aborted) source.destroy();
  }
}

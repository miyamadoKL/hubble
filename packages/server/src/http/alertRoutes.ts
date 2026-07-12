/**
 * Alert API ルーター（`/api/alerts`）。
 *
 * Alert の CRUD と手動評価を提供する Hono サブルーター。
 * 認可は scheduleRoutes と同様に owner スコープと、評価時の
 * オーナーロール再解決（evaluator 側）で行う。
 */
import { Hono } from 'hono';
import {
  alertEvalResponseSchema,
  createAlertRequestSchema,
  updateAlertRequestSchema,
  type Alert,
} from '@hubble/contracts';
import type { Services } from '../services';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import type { Principal } from '../auth/principal';
import { requireDatasourceAccess } from '../rbac/check';
import type { AlertRecord } from '../store/alerts';
import { nextRunIso } from '../schedule/cron';
import { parseJsonBody } from './validate';
import { JobAdmissionRejectedError } from '../schedule/admission';

type App = Hono<{ Variables: AuthVariables }>;

function toAlert(record: AlertRecord): Alert {
  return {
    id: record.id,
    name: record.name,
    savedQueryId: record.savedQueryId,
    columnName: record.columnName,
    op: record.op,
    value: record.value,
    selector: record.selector,
    rearm: record.rearm,
    muted: record.muted,
    cron: record.cron,
    state: record.state,
    lastTriggeredAt: record.lastTriggeredAt,
    notifications: record.notifications,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    nextEvalAt: record.muted ? null : nextRunIso(record.cron, new Date()),
  };
}

async function assertSavedQueryAccessible(
  services: Services,
  principal: Principal,
  savedQueryId: string,
) {
  const sq = await services.savedQueries.get(
    { user: principal.user, groups: principal.groups ?? [], role: principal.role.name },
    savedQueryId,
  );
  if (!sq) {
    throw AppError.notFound(`Saved query ${savedQueryId} not found`);
  }
  const datasourceId = sq.datasourceId ?? services.defaultDatasourceId;
  return { sq, datasourceId };
}

/**
 * Alert CRUD と手動評価エンドポイントをまとめた Hono サブルーター。
 */
export function alertRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  app.get('/', async (c) => {
    const owner = c.var.principal.user;
    const records = await services.alerts.list(owner);
    return c.json(records.map(toAlert));
  });

  app.post('/', async (c) => {
    const owner = c.var.principal.user;
    const body = await parseJsonBody(c, createAlertRequestSchema);
    const { datasourceId } = await assertSavedQueryAccessible(
      services,
      c.var.principal,
      body.savedQueryId,
    );
    requireDatasourceAccess(c.var.principal.role, datasourceId);
    const record = await services.alerts.create(owner, {
      ...body,
      principalSnapshot: c.var.principal,
    });
    return c.json(toAlert(record), 201);
  });

  app.get('/:id', async (c) => {
    const owner = c.var.principal.user;
    const record = await services.alerts.get(owner, c.req.param('id'));
    if (!record) throw AppError.notFound(`Alert ${c.req.param('id')} not found`);
    return c.json(toAlert(record));
  });

  app.put('/:id', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const existing = await services.alerts.get(owner, id);
    if (!existing) throw AppError.notFound(`Alert ${id} not found`);
    const body = await parseJsonBody(c, updateAlertRequestSchema);
    const savedQueryId = body.savedQueryId ?? existing.savedQueryId;
    const { datasourceId } = await assertSavedQueryAccessible(
      services,
      c.var.principal,
      savedQueryId,
    );
    requireDatasourceAccess(c.var.principal.role, datasourceId);
    const updated = await services.alerts.update(owner, id, {
      ...body,
      principalSnapshot: c.var.principal,
    });
    if (!updated) throw AppError.notFound(`Alert ${id} not found`);
    return c.json(toAlert(updated));
  });

  app.delete('/:id', async (c) => {
    const owner = c.var.principal.user;
    const ok = await services.alerts.delete(owner, c.req.param('id'));
    if (!ok) throw AppError.notFound(`Alert ${c.req.param('id')} not found`);
    return c.json({ ok: true });
  });

  app.post('/:id/eval', async (c) => {
    const owner = c.var.principal.user;
    const id = c.req.param('id');
    const record = await services.alerts.get(owner, id);
    if (!record) throw AppError.notFound(`Alert ${id} not found`);
    try {
      const outcome = await services.alertEvaluator.evalManual(record);
      return c.json(alertEvalResponseSchema.parse(outcome));
    } catch (err) {
      if (err instanceof JobAdmissionRejectedError) {
        if (err.reason === 'closed') {
          throw new AppError(503, {
            code: 'SERVER_SHUTTING_DOWN',
            message: 'Scheduled job admission is closed',
          });
        }
        const message =
          err.reason === 'duplicate'
            ? `An evaluation is already in progress for alert ${id}`
            : 'The scheduled job concurrency limit has been reached';
        throw AppError.conflict(message);
      }
      throw err;
    }
  });

  return app;
}

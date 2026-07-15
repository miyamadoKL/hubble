/**
 * Dashboard API ルーター（`/api/dashboards`）。
 *
 * Dashboard の CRUD と document_shares 経由の共有設定を提供する Hono サブルーター。
 * 認可は notebooks と同様に owner スコープと共有 permission で行う。
 * パネルのデータ取得はクライアントが既存の POST /api/queries を呼ぶ設計のため、
 * ここではクエリ実行エンドポイントを提供しない。
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  createDashboardRequestSchema,
  dashboardListItemSchema,
  dashboardResponseSchema,
  listDocumentSharesResponseSchema,
  updateDashboardRequestSchema,
  updateSharesRequestSchema,
} from '@hubble/contracts';
import type { Services } from '../services';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import {
  requireDocumentOwner,
  throwDeleteResult,
  throwUpdateResult,
  toShareAccessor,
} from './documentAccess';
import { parseJsonBody } from './validate';

type App = Hono<{ Variables: AuthVariables }>;

const dashboardListResponseSchema = z.array(dashboardListItemSchema);

/**
 * Dashboard CRUD + search, mounted under `/api/dashboards`. Every operation is
 * scoped to the request principal (owner or shared access).
 *
 * @param services - DI コンテナ。`services.dashboards` の永続化ロジックに処理を委譲する。
 * @returns `/api/dashboards` 配下にマウントする Hono サブアプリケーション。
 */
export function dashboardRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  app.get('/', async (c) => {
    const accessor = toShareAccessor(c.var.principal);
    return c.json(
      dashboardListResponseSchema.parse(
        await services.dashboards.list(accessor, c.req.query('query')),
      ),
    );
  });

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createDashboardRequestSchema);
    return c.json(
      dashboardResponseSchema.parse(await services.dashboards.create(c.var.principal.user, body)),
      201,
    );
  });

  app.get('/:id/shares', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    await requireDocumentOwner(services, 'dashboard', id, accessor);
    const shares = await services.documentShares.listForDocument('dashboard', id);
    return c.json(listDocumentSharesResponseSchema.parse({ shares }));
  });

  app.put('/:id/shares', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    await requireDocumentOwner(services, 'dashboard', id, accessor);
    const body = await parseJsonBody(c, updateSharesRequestSchema);
    const shares = await services.documentShares.replaceForDocument(
      'dashboard',
      id,
      body.shares,
      accessor.user,
    );
    await services.audit.record({
      actor: accessor.user,
      action: 'document.share.update',
      target: `dashboard:${id}`,
      detail: {
        count: shares.length,
        shares: shares.map((share) => ({
          subjectType: share.subjectType,
          subjectValue: share.subjectValue,
          permission: share.permission,
        })),
      },
    });
    return c.json(listDocumentSharesResponseSchema.parse({ shares }));
  });

  app.get('/:id', async (c) => {
    const accessor = toShareAccessor(c.var.principal);
    const dashboard = await services.dashboards.get(accessor, c.req.param('id'));
    if (!dashboard) throw AppError.notFound(`Dashboard ${c.req.param('id')} not found`);
    return c.json(dashboardResponseSchema.parse(dashboard));
  });

  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, updateDashboardRequestSchema);
    const accessor = toShareAccessor(c.var.principal);
    const updated = throwUpdateResult(
      await services.dashboards.update(accessor, id, body),
      'dashboard',
      id,
    );
    return c.json(dashboardResponseSchema.parse(updated));
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    throwDeleteResult(await services.dashboards.delete(accessor, id), 'dashboard', id);
    return c.json({ ok: true });
  });

  return app;
}

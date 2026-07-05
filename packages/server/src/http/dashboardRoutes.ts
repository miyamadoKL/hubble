/**
 * Dashboard API ルーター（`/api/dashboards`）。
 *
 * Dashboard の CRUD と document_shares 経由の共有設定を提供する Hono サブルーター。
 * 認可は notebooks と同様に owner スコープと共有 permission で行う。
 * パネルのデータ取得はクライアントが既存の POST /api/queries を呼ぶ設計のため、
 * ここではクエリ実行エンドポイントを提供しない。
 */
import { Hono } from 'hono';
import {
  createDashboardRequestSchema,
  listDocumentSharesResponseSchema,
  updateDashboardRequestSchema,
  updateSharesRequestSchema,
} from '@hubble/contracts';
import type { Services } from '../services';
import type { AuthVariables } from '../auth/middleware';
import type { Principal } from '../auth/principal';
import { AppError } from '../errors';
import type { DocumentType } from '../store/documentShares';
import type { ShareAccessor, StoreForbidden } from '../store/documentShares';
import { parseJsonBody } from './validate';

type App = Hono<{ Variables: AuthVariables }>;

/** principal から共有 permission 解決用 accessor を組み立てる。 */
function toShareAccessor(principal: Principal): ShareAccessor {
  return {
    user: principal.user,
    groups: principal.groups ?? [],
    role: principal.role.name,
  };
}

/** owner 以外 (共有されている者を含む) は 403、存在しない/アクセス不能は 404。 */
async function requireDocumentOwner(
  services: Services,
  type: DocumentType,
  id: string,
  accessor: ShareAccessor,
): Promise<void> {
  const owner =
    type === 'notebook'
      ? await services.notebooks.getOwner(id)
      : type === 'dashboard'
        ? await services.dashboards.getOwner(id)
        : await services.savedQueries.getOwner(id);
  if (!owner) {
    throw AppError.notFound(
      type === 'notebook'
        ? `Notebook ${id} not found`
        : type === 'dashboard'
          ? `Dashboard ${id} not found`
          : `Saved query ${id} not found`,
    );
  }
  if (owner !== accessor.user) {
    const permission = await services.documentShares.resolvePermission(type, id, accessor);
    if (permission) {
      throw AppError.forbidden('Only the document owner can manage shares');
    }
    throw AppError.notFound(
      type === 'notebook'
        ? `Notebook ${id} not found`
        : type === 'dashboard'
          ? `Dashboard ${id} not found`
          : `Saved query ${id} not found`,
    );
  }
}

function throwUpdateResult<T>(result: T | undefined | StoreForbidden, notFoundMessage: string): T {
  if (result === 'forbidden') {
    throw AppError.forbidden('Insufficient permission to update this document');
  }
  if (!result) {
    throw AppError.notFound(notFoundMessage);
  }
  return result;
}

function throwDeleteResult(result: boolean | StoreForbidden, notFoundMessage: string): void {
  if (result === 'forbidden') {
    throw AppError.forbidden('Only the document owner can delete this document');
  }
  if (!result) {
    throw AppError.notFound(notFoundMessage);
  }
}

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
    return c.json(await services.dashboards.list(accessor, c.req.query('query')));
  });

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createDashboardRequestSchema);
    return c.json(await services.dashboards.create(c.var.principal.user, body), 201);
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
    return c.json(dashboard);
  });

  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, updateDashboardRequestSchema);
    const accessor = toShareAccessor(c.var.principal);
    const updated = throwUpdateResult(
      await services.dashboards.update(accessor, id, body),
      `Dashboard ${id} not found`,
    );
    return c.json(updated);
  });

  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    throwDeleteResult(await services.dashboards.delete(accessor, id), `Dashboard ${id} not found`);
    return c.json({ ok: true });
  });

  return app;
}

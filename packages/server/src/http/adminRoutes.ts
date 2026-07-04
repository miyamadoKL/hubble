/**
 * RBAC 運用ビュー向けの管理 API ルーター。
 */
import { Hono } from 'hono';
import type { AdminQueryItem } from '@hubble/contracts';
import type { Services } from '../services';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import { requirePermission } from '../rbac/check';
import type { QueryExecution } from '../query/execution';

const STATEMENT_PREVIEW_MAX = 200;

function truncateStatement(statement: string): string {
  if (statement.length <= STATEMENT_PREVIEW_MAX) return statement;
  return statement.slice(0, STATEMENT_PREVIEW_MAX);
}

function toAdminItem(exec: QueryExecution, now: number): AdminQueryItem {
  const owner = exec.ctx.user ?? 'unknown';
  const endAt = exec.finishedAt ?? now;
  return {
    queryId: exec.queryId,
    owner,
    datasourceId: exec.datasourceId,
    statement: truncateStatement(exec.statement),
    state: exec.state,
    elapsedMs: Math.max(endAt - exec.submittedAt, 0),
    ...(exec.stats ? { stats: exec.stats } : {}),
  };
}

/**
 * 管理 API ルーターを構築する。
 * @param services - DI コンテナ。
 * @returns `/api/admin` 配下にマウントする Hono サブアプリケーション。
 */
export function adminRoutes(services: Services): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // GET /api/admin/queries — 全ユーザーの実行中/保持中クエリ一覧。
  app.get('/queries', (c) => {
    requirePermission(c.var.principal.role, 'queries.viewAll');
    const now = Date.now();
    const items = services.registry
      .listAll()
      .sort((a, b) => b.submittedAt - a.submittedAt)
      .map((exec) => toAdminItem(exec, now));
    return c.json({ items });
  });

  // DELETE /api/admin/queries/:id — 任意ユーザーのクエリを kill。
  app.delete('/queries/:id', async (c) => {
    requirePermission(c.var.principal.role, 'query.killAny');
    const queryId = c.req.param('id');
    const exec = services.registry.get(queryId);
    if (!exec) throw AppError.notFound(`Query ${queryId} not found`);

    const actor = c.var.principal.user;
    const targetOwner = exec.ctx.user ?? 'unknown';
    console.log(`[rbac] admin kill: actor=${actor} targetOwner=${targetOwner} queryId=${queryId}`);
    await services.audit.record({
      actor,
      action: 'query.kill',
      target: queryId,
      datasource: exec.datasourceId,
      detail: {
        targetOwner,
        state: exec.state,
      },
    });

    await exec.requestCancel();
    return c.json(exec.snapshot());
  });

  return app;
}

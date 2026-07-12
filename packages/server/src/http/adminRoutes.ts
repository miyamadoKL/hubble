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
import { auditActionSchema } from '../audit';

const STATEMENT_PREVIEW_MAX = 200;
const AUDIT_PAGE_MAX = 200;

interface AuditCursor {
  createdAt: string;
  id: string;
}

function decodeAuditCursor(value: string): AuditCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as AuditCursor).createdAt === 'string' &&
      !Number.isNaN(Date.parse((parsed as AuditCursor).createdAt)) &&
      typeof (parsed as AuditCursor).id === 'string'
    ) {
      return parsed as AuditCursor;
    }
  } catch {
    // 不正なカーソルは下の共通エラーへ変換する。
  }
  throw AppError.badRequest('Invalid audit cursor', 'VALIDATION_ERROR');
}

function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function optionalIso(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (Number.isNaN(Date.parse(value))) {
    throw AppError.badRequest(`Invalid ${name} timestamp`, 'VALIDATION_ERROR');
  }
  return new Date(value).toISOString();
}

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

  // GET /api/admin/audit-logs — 権限を分離した監査ログのカーソル検索。
  app.get('/audit-logs', async (c) => {
    requirePermission(c.var.principal.role, 'audit.view');
    const rawLimit = c.req.query('limit');
    const limit = rawLimit === undefined ? 100 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > AUDIT_PAGE_MAX) {
      throw AppError.badRequest(`limit must be an integer from 1 to ${AUDIT_PAGE_MAX}`);
    }
    const rawAction = c.req.query('action');
    const action = rawAction === undefined ? undefined : auditActionSchema.safeParse(rawAction);
    if (action !== undefined && !action.success) {
      throw AppError.badRequest('Invalid audit action', 'VALIDATION_ERROR');
    }
    const from = optionalIso(c.req.query('from'), 'from');
    const to = optionalIso(c.req.query('to'), 'to');
    const result = await services.audit.search({
      limit,
      ...(c.req.query('actor') ? { actor: c.req.query('actor') } : {}),
      ...(action?.success ? { action: action.data } : {}),
      ...(c.req.query('datasource') ? { datasource: c.req.query('datasource') } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(c.req.query('cursor') ? { cursor: decodeAuditCursor(c.req.query('cursor')!) } : {}),
    });
    return c.json({
      items: result.items,
      ...(result.nextCursor ? { nextCursor: encodeAuditCursor(result.nextCursor) } : {}),
    });
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

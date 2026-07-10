/**
 * 永続化ストア系 API ルーター（`packages/server/src/http/storeRoutes.ts`）。
 *
 * 「ノートブック」「保存済みクエリ」「実行履歴」という 3 種類のユーザー所有リソースに対する
 * CRUD / 検索エンドポイントをまとめて提供する。それぞれ独立した Hono サブルーターとして
 * ファクトリ関数（`notebookRoutes` / `savedQueryRoutes` / `historyRoutes`）でエクスポートし、
 * `app.ts` から `/api/notebooks` / `/api/saved-queries` / `/api/history` にそれぞれマウントされる。
 *
 * どの操作もリクエスト principal（`c.var.principal`）を基点とするスコープ設計で、
 * 実データの永続化や検索ロジックは
 * `services.notebooks` / `services.savedQueries` / `services.history` に委譲する。
 * ノートブックと保存済みクエリは所有分に加え document_shares 経由の共有アクセスも
 * 対象とする。共有設定の GET/PUT は owner のみが操作できる。
 */
import { Hono } from 'hono';
import {
  createNotebookRequestSchema,
  createSavedQueryRequestSchema,
  listDocumentSharesResponseSchema,
  queryStateSchema,
  updateNotebookRequestSchema,
  updateSavedQueryRequestSchema,
  updateSharesRequestSchema,
} from '@hubble/contracts';
import type { Services } from '../services';
import type { AuthVariables } from '../auth/middleware';
import type { Principal } from '../auth/principal';
import { AppError } from '../errors';
import type { DocumentType } from '../store/documentShares';
import type { ShareAccessor, StoreForbidden } from '../store/documentShares';
import { intParam, parseJsonBody } from './validate';

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
      : await services.savedQueries.getOwner(id);
  if (!owner) {
    throw AppError.notFound(
      type === 'notebook' ? `Notebook ${id} not found` : `Saved query ${id} not found`,
    );
  }
  if (owner !== accessor.user) {
    const permission = await services.documentShares.resolvePermission(type, id, accessor);
    if (permission) {
      throw AppError.forbidden('Only the document owner can manage shares');
    }
    throw AppError.notFound(
      type === 'notebook' ? `Notebook ${id} not found` : `Saved query ${id} not found`,
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
 * Notebook CRUD + search, mounted under `/api/notebooks`. Every operation is
 * scoped to the request principal (owner or shared access).
 *
 * ノートブック（保存された SQL セル群）の CRUD と検索エンドポイントを構築するファクトリ関数。
 * 所有分に加え document_shares 経由の共有アクセスも対象とする。
 * @param services - DI コンテナ。`services.notebooks` の永続化ロジックに処理を委譲する。
 * @returns `/api/notebooks` 配下にマウントする Hono サブアプリケーション。
 */
export function notebookRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  // GET /api/notebooks?query=: 所有と共有ノートブックの一覧（クエリ文字列で絞り込み検索も可能）。
  app.get('/', async (c) => {
    const accessor = toShareAccessor(c.var.principal);
    return c.json(await services.notebooks.list(accessor, c.req.query('query')));
  });

  // POST /api/notebooks: 新規ノートブックを作成する。
  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createNotebookRequestSchema);
    return c.json(await services.notebooks.create(c.var.principal.user, body), 201);
  });

  // GET /api/notebooks/:id/shares: 共有エントリ一覧を取得する（owner のみ）。
  app.get('/:id/shares', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    await requireDocumentOwner(services, 'notebook', id, accessor);
    const shares = await services.documentShares.listForDocument('notebook', id);
    return c.json(listDocumentSharesResponseSchema.parse({ shares }));
  });

  // PUT /api/notebooks/:id/shares: 共有一覧を全置換する（owner のみ、監査ログに記録）。
  app.put('/:id/shares', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    await requireDocumentOwner(services, 'notebook', id, accessor);
    const body = await parseJsonBody(c, updateSharesRequestSchema);
    const shares = await services.documentShares.replaceForDocument(
      'notebook',
      id,
      body.shares,
      accessor.user,
    );
    await services.audit.record({
      actor: accessor.user,
      action: 'document.share.update',
      target: `notebook:${id}`,
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

  // GET /api/notebooks/:id: 単一ノートブックを取得する（所有も共有もないものは 404）。
  app.get('/:id', async (c) => {
    const accessor = toShareAccessor(c.var.principal);
    const notebook = await services.notebooks.get(accessor, c.req.param('id'));
    if (!notebook) throw AppError.notFound(`Notebook ${c.req.param('id')} not found`);
    return c.json(notebook);
  });

  // PUT /api/notebooks/:id: ノートブック全体を置き換える更新（owner または edit 共有者のみ）。
  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, updateNotebookRequestSchema);
    const accessor = toShareAccessor(c.var.principal);
    const result = await services.notebooks.update(accessor, id, body);
    if (result === 'conflict') {
      throw new AppError(409, {
        code: 'NOTEBOOK_REVISION_CONFLICT',
        message: 'Notebook was updated by another editor',
      });
    }
    const updated = throwUpdateResult(result, `Notebook ${id} not found`);
    return c.json(updated);
  });

  // DELETE /api/notebooks/:id: ノートブックを削除する（owner のみ）。
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    throwDeleteResult(await services.notebooks.delete(accessor, id), `Notebook ${id} not found`);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Saved-query CRUD + search, mounted under `/api/saved-queries`. Scoped to the
 * request principal (owner or shared access).
 *
 * お気に入り/保存済みクエリの CRUD と検索エンドポイントを構築するファクトリ関数。
 * 所有分に加え document_shares 経由の共有アクセスも対象とする。
 * @param services - DI コンテナ。`services.savedQueries` の永続化ロジックに処理を委譲する。
 * @returns `/api/saved-queries` 配下にマウントする Hono サブアプリケーション。
 */
export function savedQueryRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  // GET /api/saved-queries?query=: 保存済みクエリの一覧（所有のお気に入りが先頭に来る想定、共有分を含む、検索も可能）。
  app.get('/', async (c) => {
    const accessor = toShareAccessor(c.var.principal);
    return c.json(await services.savedQueries.list(accessor, c.req.query('query')));
  });

  // POST /api/saved-queries: 新規に保存する。
  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createSavedQueryRequestSchema);
    return c.json(await services.savedQueries.create(c.var.principal.user, body), 201);
  });

  // GET /api/saved-queries/:id/shares: 共有エントリ一覧を取得する（owner のみ）。
  app.get('/:id/shares', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    await requireDocumentOwner(services, 'saved_query', id, accessor);
    const shares = await services.documentShares.listForDocument('saved_query', id);
    return c.json(listDocumentSharesResponseSchema.parse({ shares }));
  });

  // PUT /api/saved-queries/:id/shares: 共有一覧を全置換する（owner のみ、監査ログに記録）。
  app.put('/:id/shares', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    await requireDocumentOwner(services, 'saved_query', id, accessor);
    const body = await parseJsonBody(c, updateSharesRequestSchema);
    const shares = await services.documentShares.replaceForDocument(
      'saved_query',
      id,
      body.shares,
      accessor.user,
    );
    await services.audit.record({
      actor: accessor.user,
      action: 'document.share.update',
      target: `saved_query:${id}`,
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

  // GET /api/saved-queries/:id: 単一の保存済みクエリを取得する（所有も共有もないものは 404）。
  app.get('/:id', async (c) => {
    const accessor = toShareAccessor(c.var.principal);
    const saved = await services.savedQueries.get(accessor, c.req.param('id'));
    if (!saved) throw AppError.notFound(`Saved query ${c.req.param('id')} not found`);
    return c.json(saved);
  });

  // PUT /api/saved-queries/:id: 保存済みクエリを更新する（名前、本文、お気に入り状態など。owner または edit 共有者のみ）。
  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await parseJsonBody(c, updateSavedQueryRequestSchema);
    const accessor = toShareAccessor(c.var.principal);
    const updated = throwUpdateResult(
      await services.savedQueries.update(accessor, id, body),
      `Saved query ${id} not found`,
    );
    return c.json(updated);
  });

  // DELETE /api/saved-queries/:id: 保存済みクエリを削除する（owner のみ）。
  app.delete('/:id', async (c) => {
    const id = c.req.param('id');
    const accessor = toShareAccessor(c.var.principal);
    throwDeleteResult(
      await services.savedQueries.delete(accessor, id),
      `Saved query ${id} not found`,
    );
    return c.json({ ok: true });
  });

  return app;
}

/**
 * History listing, mounted under `/api/history`. Owner-scoped.
 *
 * クエリ実行履歴の一覧取得エンドポイントを構築するファクトリ関数。状態フィルタや
 * オフセット/リミットページングに対応する。
 * @param services - DI コンテナ。`services.history` の永続化ロジックに処理を委譲する。
 * @returns `/api/history` 配下にマウントする Hono サブアプリケーション。
 */
export function historyRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  // GET /api/history?state&offset&limit: 実行履歴の一覧。state はコントラクトの
  // queryStateSchema で検証し、不正な値は 400 で弾く。
  app.get('/', async (c) => {
    const stateRaw = c.req.query('state');
    const stateParsed = stateRaw ? queryStateSchema.safeParse(stateRaw) : undefined;
    if (stateRaw && stateParsed && !stateParsed.success) {
      throw AppError.badRequest(`Invalid state filter: ${stateRaw}`, 'VALIDATION_ERROR');
    }
    return c.json(
      await services.history.list(c.var.principal.user, {
        offset: intParam(c.req.query('offset'), 0),
        limit: intParam(c.req.query('limit'), 50),
        state: stateParsed?.success ? stateParsed.data : undefined,
      }),
    );
  });

  return app;
}

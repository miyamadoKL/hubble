/**
 * 永続化ストア系 API ルーター（`packages/server/src/http/storeRoutes.ts`）。
 *
 * 「ノートブック」「保存済みクエリ」「実行履歴」という 3 種類のユーザー所有リソースに対する
 * CRUD / 検索エンドポイントをまとめて提供する。それぞれ独立した Hono サブルーターとして
 * ファクトリ関数（`notebookRoutes` / `savedQueryRoutes` / `historyRoutes`）でエクスポートし、
 * `app.ts` から `/api/notebooks` / `/api/saved-queries` / `/api/history` にそれぞれマウントされる。
 *
 * どの操作もリクエスト principal（`c.var.principal.user`）の所有物のみを対象とする
 * オーナースコープ設計で、実データの永続化や検索ロジックは
 * `services.notebooks` / `services.savedQueries` / `services.history` に委譲する。
 */
import { Hono } from 'hono';
import {
  createNotebookRequestSchema,
  createSavedQueryRequestSchema,
  queryStateSchema,
  updateNotebookRequestSchema,
  updateSavedQueryRequestSchema,
} from '@hubble/contracts';
import type { Services } from '../services';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import { intParam, parseJsonBody } from './validate';

type App = Hono<{ Variables: AuthVariables }>;

/**
 * Notebook CRUD + search, mounted under `/api/notebooks`. Every operation is
 * scoped to the request principal's owner id.
 *
 * ノートブック（保存された SQL セル群）の CRUD と検索エンドポイントを構築するファクトリ関数。
 * @param services - DI コンテナ。`services.notebooks` の永続化ロジックに処理を委譲する。
 * @returns `/api/notebooks` 配下にマウントする Hono サブアプリケーション。
 */
export function notebookRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  // GET /api/notebooks?query=: 所有ノートブックの一覧（クエリ文字列で絞り込み検索も可能）。
  app.get('/', async (c) => {
    const owner = c.var.principal.user;
    return c.json(await services.notebooks.list(owner, c.req.query('query')));
  });

  // POST /api/notebooks: 新規ノートブックを作成する。
  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createNotebookRequestSchema);
    return c.json(await services.notebooks.create(c.var.principal.user, body), 201);
  });

  // GET /api/notebooks/:id: 単一ノートブックを取得する（他ユーザー所有分は 404）。
  app.get('/:id', async (c) => {
    const notebook = await services.notebooks.get(c.var.principal.user, c.req.param('id'));
    if (!notebook) throw AppError.notFound(`Notebook ${c.req.param('id')} not found`);
    return c.json(notebook);
  });

  // PUT /api/notebooks/:id: ノートブック全体を置き換える更新。
  app.put('/:id', async (c) => {
    const body = await parseJsonBody(c, updateNotebookRequestSchema);
    const updated = await services.notebooks.update(c.var.principal.user, c.req.param('id'), body);
    if (!updated) throw AppError.notFound(`Notebook ${c.req.param('id')} not found`);
    return c.json(updated);
  });

  // DELETE /api/notebooks/:id: ノートブックを削除する。
  app.delete('/:id', async (c) => {
    const ok = await services.notebooks.delete(c.var.principal.user, c.req.param('id'));
    if (!ok) throw AppError.notFound(`Notebook ${c.req.param('id')} not found`);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * Saved-query CRUD + search, mounted under `/api/saved-queries`. Owner-scoped.
 *
 * お気に入り/保存済みクエリの CRUD と検索エンドポイントを構築するファクトリ関数。
 * @param services - DI コンテナ。`services.savedQueries` の永続化ロジックに処理を委譲する。
 * @returns `/api/saved-queries` 配下にマウントする Hono サブアプリケーション。
 */
export function savedQueryRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  // GET /api/saved-queries?query=: 保存済みクエリの一覧（お気に入りが先頭に来る想定、検索も可能）。
  app.get('/', async (c) => {
    return c.json(await services.savedQueries.list(c.var.principal.user, c.req.query('query')));
  });

  // POST /api/saved-queries: 新規に保存する。
  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createSavedQueryRequestSchema);
    return c.json(await services.savedQueries.create(c.var.principal.user, body), 201);
  });

  // GET /api/saved-queries/:id: 単一の保存済みクエリを取得する。
  app.get('/:id', async (c) => {
    const saved = await services.savedQueries.get(c.var.principal.user, c.req.param('id'));
    if (!saved) throw AppError.notFound(`Saved query ${c.req.param('id')} not found`);
    return c.json(saved);
  });

  // PUT /api/saved-queries/:id: 保存済みクエリを更新する（名前、本文、お気に入り状態など）。
  app.put('/:id', async (c) => {
    const body = await parseJsonBody(c, updateSavedQueryRequestSchema);
    const updated = await services.savedQueries.update(
      c.var.principal.user,
      c.req.param('id'),
      body,
    );
    if (!updated) throw AppError.notFound(`Saved query ${c.req.param('id')} not found`);
    return c.json(updated);
  });

  // DELETE /api/saved-queries/:id: 保存済みクエリを削除する。
  app.delete('/:id', async (c) => {
    const ok = await services.savedQueries.delete(c.var.principal.user, c.req.param('id'));
    if (!ok) throw AppError.notFound(`Saved query ${c.req.param('id')} not found`);
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

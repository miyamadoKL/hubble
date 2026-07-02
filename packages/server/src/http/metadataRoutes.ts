/**
 * メタデータ API ルーター（`packages/server/src/http/metadataRoutes.ts`）。
 *
 * design.md §7 が定義するメタデータ系エンドポイント（カタログ一覧 / スキーマ一覧 /
 * テーブル一覧 / カラム定義を含むテーブル詳細 / サンプル行取得、および明示的な再取得を行う
 * `POST /api/metadata/refresh`）を提供する Hono サブルーター。`/api` 配下にマウントされる
 * （他のルーターと異なりオーナースコープではなく、カタログ情報はテナント共通のためユーザー非依存）。
 *
 * 実際の Trino への `information_schema` / `system.metadata` 問い合わせとキャッシュ管理は
 * `services.metadata` に委譲し、このファイルは HTTP のルーティングとレスポンス整形のみを担当する。
 */
import { Hono } from 'hono';
import { metadataRefreshRequestSchema, tableDetailSchema } from '@hubble/contracts';
import type { Services } from '../services';
import { parseJsonBody } from './validate';

/**
 * Metadata endpoints (design.md §7): catalogs / schemas / tables / table detail
 * / sample, plus `POST /api/metadata/refresh`. All mounted under `/api`.
 *
 * メタデータ参照系エンドポイントをまとめた Hono サブルーターを構築するファクトリ関数。
 * @param services - DI コンテナ。`services.metadata` のキャッシュ付き Trino メタデータ取得に
 *   処理を委譲する。
 * @returns `/api` 配下にマウントする Hono サブアプリケーション。
 */
export function metadataRoutes(services: Services): Hono {
  const app = new Hono();

  // GET /api/catalogs: 利用可能な Trino カタログ一覧（キャッシュ経由、無ければ live 取得）。
  app.get('/catalogs', async (c) => {
    return c.json(await services.metadata.getCatalogs());
  });

  // GET /api/catalogs/:c/schemas: 指定カタログ配下のスキーマ一覧。
  app.get('/catalogs/:c/schemas', async (c) => {
    return c.json(await services.metadata.getSchemas(c.req.param('c')));
  });

  // GET /api/catalogs/:c/schemas/:s/tables: 指定スキーマ配下のテーブル一覧。
  app.get('/catalogs/:c/schemas/:s/tables', async (c) => {
    return c.json(await services.metadata.getTables(c.req.param('c'), c.req.param('s')));
  });

  // GET /api/catalogs/:c/schemas/:s/tables/:t: テーブル詳細（カラム名/型/コメント等）。
  // レスポンスはコントラクトの tableDetailSchema で検証してから返す。
  app.get('/catalogs/:c/schemas/:s/tables/:t', async (c) => {
    const raw = await services.metadata.getTableDetail(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
    );
    return c.json(tableDetailSchema.parse(raw));
  });

  // GET /api/catalogs/:c/schemas/:s/tables/:t/sample: テーブルのサンプル行を取得する
  // （エディタでのプレビュー用途）。
  app.get('/catalogs/:c/schemas/:s/tables/:t/sample', async (c) => {
    const sample = await services.metadata.getSample(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
    );
    return c.json(sample);
  });

  // POST /api/metadata/refresh: 指定 catalog/schema のメタデータキャッシュを明示的に破棄し、
  // Trino から再取得する。
  app.post('/metadata/refresh', async (c) => {
    const body = await parseJsonBody(c, metadataRefreshRequestSchema);
    await services.metadata.refresh(body.catalog, body.schema);
    return c.json({ ok: true });
  });

  return app;
}

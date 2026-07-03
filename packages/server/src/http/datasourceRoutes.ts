/**
 * データソース一覧 API ルーター。
 *
 * `GET /api/datasources` で宣言的に設定されたデータソースの公開サマリーを返す。
 * 接続先 URL や認証情報はレスポンスに含めない。
 */
import { Hono } from 'hono';
import { datasourcesResponseSchema } from '@hubble/contracts';
import type { Services } from '../services';
import { toDatasourceSummaries } from '../datasource/summary';

/**
 * データソース一覧エンドポイントを提供する Hono サブルーターを構築する。
 * @param services - DI コンテナ。`services.datasources` の解決済み一覧をサマリーに変換して返す。
 * @returns `/api/datasources` にマウントする Hono サブアプリケーション。
 */
export function datasourceRoutes(services: Services): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const response = datasourcesResponseSchema.parse({
      datasources: toDatasourceSummaries(services.datasources),
    });
    return c.json(response);
  });

  return app;
}

/**
 * メタデータ API ルーター。
 *
 * 既定データソース向けのレガシールート（`GET /api/catalogs` 等）と、
 * データソーススコープ付きルート（`GET /api/datasources/:id/catalogs` 等）を提供する。
 * レガシールートは Phase 4 で web 移行後に削除予定。
 */
import { Hono } from 'hono';
import { metadataRefreshRequestSchema, tableDetailSchema } from '@hubble/contracts';
import type { Services } from '../services';
import { resolveEngine } from '../engine/resolve';
import { parseJsonBody } from './validate';

/**
 * 既定データソース向けのレガシーメタデータルート（`/api/catalogs` 等）。
 * Phase 4 で web 移行後に削除予定。内部では defaultDatasourceId へ委譲する。
 */
export function metadataRoutes(services: Services): Hono {
  const app = new Hono();
  const defaultId = services.defaultDatasourceId;

  app.get('/catalogs', async (c) => {
    return c.json(await services.metadata.getCatalogs(defaultId));
  });

  app.get('/catalogs/:c/schemas', async (c) => {
    return c.json(await services.metadata.getSchemas(c.req.param('c'), defaultId));
  });

  app.get('/catalogs/:c/schemas/:s/tables', async (c) => {
    return c.json(await services.metadata.getTables(c.req.param('c'), c.req.param('s'), defaultId));
  });

  app.get('/catalogs/:c/schemas/:s/tables/:t', async (c) => {
    const raw = await services.metadata.getTableDetail(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
      defaultId,
    );
    return c.json(tableDetailSchema.parse(raw));
  });

  app.get('/catalogs/:c/schemas/:s/tables/:t/sample', async (c) => {
    const sample = await services.metadata.getSample(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
      10,
      defaultId,
    );
    return c.json(sample);
  });

  app.post('/metadata/refresh', async (c) => {
    const body = await parseJsonBody(c, metadataRefreshRequestSchema);
    await services.metadata.refresh(body.catalog, body.schema, defaultId);
    return c.json({ ok: true });
  });

  return app;
}

/**
 * データソーススコープ付きメタデータルート（`/api/datasources/:datasourceId/...`）。
 */
export function datasourceMetadataRoutes(services: Services): Hono {
  const app = new Hono();

  app.get('/:datasourceId/catalogs', async (c) => {
    const datasourceId = c.req.param('datasourceId');
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    return c.json(await services.metadata.getCatalogs(datasourceId));
  });

  app.get('/:datasourceId/catalogs/:c/schemas', async (c) => {
    const datasourceId = c.req.param('datasourceId');
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    return c.json(await services.metadata.getSchemas(c.req.param('c'), datasourceId));
  });

  app.get('/:datasourceId/catalogs/:c/schemas/:s/tables', async (c) => {
    const datasourceId = c.req.param('datasourceId');
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    return c.json(
      await services.metadata.getTables(c.req.param('c'), c.req.param('s'), datasourceId),
    );
  });

  app.get('/:datasourceId/catalogs/:c/schemas/:s/tables/:t', async (c) => {
    const datasourceId = c.req.param('datasourceId');
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    const raw = await services.metadata.getTableDetail(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
      datasourceId,
    );
    return c.json(tableDetailSchema.parse(raw));
  });

  app.get('/:datasourceId/catalogs/:c/schemas/:s/tables/:t/sample', async (c) => {
    const datasourceId = c.req.param('datasourceId');
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    const sample = await services.metadata.getSample(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
      10,
      datasourceId,
    );
    return c.json(sample);
  });

  return app;
}

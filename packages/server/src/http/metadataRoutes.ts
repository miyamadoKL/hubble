/**
 * データソーススコープ付きメタデータ API ルーター。
 *
 * すべてのメタデータ要求で対象 datasource を URL に含め、RBAC と engine の
 * 解決を同じ経路で実行する。
 */
import { Hono } from 'hono';
import {
  metadataRefreshRequestSchema,
  metadataRefreshResponseSchema,
  tableDetailSchema,
} from '@hubble/contracts';
import type { AuthVariables } from '../auth/middleware';
import type { Services } from '../services';
import { resolveEngine } from '../engine/resolve';
import { requireDatasourceAccess } from '../rbac/check';
import { parseJsonBody } from './validate';

/** データソーススコープ付きメタデータルート（`/api/datasources/:datasourceId/...`）。 */
export function datasourceMetadataRoutes(services: Services): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.post('/:datasourceId/metadata/refresh', async (c) => {
    const principal = c.var.principal.user;
    const datasourceId = c.req.param('datasourceId');
    requireDatasourceAccess(c.var.principal.role, datasourceId);
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    const body = await parseJsonBody(c, metadataRefreshRequestSchema);
    await services.metadata.refresh(
      principal,
      body.catalog,
      body.schema,
      datasourceId,
      c.var.principal.role.name,
    );
    return c.json(metadataRefreshResponseSchema.parse({ ok: true, datasourceId }));
  });

  app.get('/:datasourceId/catalogs', async (c) => {
    const principal = c.var.principal.user;
    const datasourceId = c.req.param('datasourceId');
    requireDatasourceAccess(c.var.principal.role, datasourceId);
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    return c.json(
      await services.metadata.getCatalogs(principal, datasourceId, c.var.principal.role.name),
    );
  });

  app.get('/:datasourceId/catalogs/:c/schemas', async (c) => {
    const principal = c.var.principal.user;
    const datasourceId = c.req.param('datasourceId');
    requireDatasourceAccess(c.var.principal.role, datasourceId);
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    return c.json(
      await services.metadata.getSchemas(
        c.req.param('c'),
        principal,
        datasourceId,
        c.var.principal.role.name,
      ),
    );
  });

  app.get('/:datasourceId/catalogs/:c/schemas/:s/tables', async (c) => {
    const principal = c.var.principal.user;
    const datasourceId = c.req.param('datasourceId');
    requireDatasourceAccess(c.var.principal.role, datasourceId);
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    return c.json(
      await services.metadata.getTables(
        c.req.param('c'),
        c.req.param('s'),
        principal,
        datasourceId,
        c.var.principal.role.name,
      ),
    );
  });

  app.get('/:datasourceId/catalogs/:c/schemas/:s/tables/:t', async (c) => {
    const principal = c.var.principal.user;
    const datasourceId = c.req.param('datasourceId');
    requireDatasourceAccess(c.var.principal.role, datasourceId);
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    const raw = await services.metadata.getTableDetail(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
      principal,
      datasourceId,
      c.var.principal.role.name,
    );
    return c.json(tableDetailSchema.parse(raw));
  });

  app.get('/:datasourceId/catalogs/:c/schemas/:s/tables/:t/sample', async (c) => {
    const principal = c.var.principal.user;
    const datasourceId = c.req.param('datasourceId');
    requireDatasourceAccess(c.var.principal.role, datasourceId);
    resolveEngine(services.engines, datasourceId, services.defaultDatasourceId);
    const sample = await services.metadata.getSample(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
      principal,
      10,
      datasourceId,
      c.var.principal.role.name,
    );
    return c.json(sample);
  });

  return app;
}

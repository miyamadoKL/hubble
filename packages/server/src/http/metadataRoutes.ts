import { Hono } from 'hono';
import { metadataRefreshRequestSchema, tableDetailSchema } from '@hubble/contracts';
import type { Services } from '../services';
import { parseJsonBody } from './validate';

/**
 * Metadata endpoints (design.md §7): catalogs / schemas / tables / table detail
 * / sample, plus `POST /api/metadata/refresh`. All mounted under `/api`.
 */
export function metadataRoutes(services: Services): Hono {
  const app = new Hono();

  app.get('/catalogs', async (c) => {
    return c.json(await services.metadata.getCatalogs());
  });

  app.get('/catalogs/:c/schemas', async (c) => {
    return c.json(await services.metadata.getSchemas(c.req.param('c')));
  });

  app.get('/catalogs/:c/schemas/:s/tables', async (c) => {
    return c.json(await services.metadata.getTables(c.req.param('c'), c.req.param('s')));
  });

  app.get('/catalogs/:c/schemas/:s/tables/:t', async (c) => {
    const raw = await services.metadata.getTableDetail(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
    );
    return c.json(tableDetailSchema.parse(raw));
  });

  app.get('/catalogs/:c/schemas/:s/tables/:t/sample', async (c) => {
    const sample = await services.metadata.getSample(
      c.req.param('c'),
      c.req.param('s'),
      c.req.param('t'),
    );
    return c.json(sample);
  });

  app.post('/metadata/refresh', async (c) => {
    const body = await parseJsonBody(c, metadataRefreshRequestSchema);
    await services.metadata.refresh(body.catalog, body.schema);
    return c.json({ ok: true });
  });

  return app;
}

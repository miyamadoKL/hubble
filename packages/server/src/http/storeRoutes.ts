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
 * scoped to the request principal's owner id (design.md §11).
 */
export function notebookRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  app.get('/', (c) => {
    const owner = c.var.principal.user;
    return c.json(services.notebooks.list(owner, c.req.query('query')));
  });

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createNotebookRequestSchema);
    return c.json(services.notebooks.create(c.var.principal.user, body), 201);
  });

  app.get('/:id', (c) => {
    const notebook = services.notebooks.get(c.var.principal.user, c.req.param('id'));
    if (!notebook) throw AppError.notFound(`Notebook ${c.req.param('id')} not found`);
    return c.json(notebook);
  });

  app.put('/:id', async (c) => {
    const body = await parseJsonBody(c, updateNotebookRequestSchema);
    const updated = services.notebooks.update(c.var.principal.user, c.req.param('id'), body);
    if (!updated) throw AppError.notFound(`Notebook ${c.req.param('id')} not found`);
    return c.json(updated);
  });

  app.delete('/:id', (c) => {
    const ok = services.notebooks.delete(c.var.principal.user, c.req.param('id'));
    if (!ok) throw AppError.notFound(`Notebook ${c.req.param('id')} not found`);
    return c.json({ ok: true });
  });

  return app;
}

/** Saved-query CRUD + search, mounted under `/api/saved-queries`. Owner-scoped. */
export function savedQueryRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  app.get('/', (c) => {
    return c.json(services.savedQueries.list(c.var.principal.user, c.req.query('query')));
  });

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createSavedQueryRequestSchema);
    return c.json(services.savedQueries.create(c.var.principal.user, body), 201);
  });

  app.get('/:id', (c) => {
    const saved = services.savedQueries.get(c.var.principal.user, c.req.param('id'));
    if (!saved) throw AppError.notFound(`Saved query ${c.req.param('id')} not found`);
    return c.json(saved);
  });

  app.put('/:id', async (c) => {
    const body = await parseJsonBody(c, updateSavedQueryRequestSchema);
    const updated = services.savedQueries.update(c.var.principal.user, c.req.param('id'), body);
    if (!updated) throw AppError.notFound(`Saved query ${c.req.param('id')} not found`);
    return c.json(updated);
  });

  app.delete('/:id', (c) => {
    const ok = services.savedQueries.delete(c.var.principal.user, c.req.param('id'));
    if (!ok) throw AppError.notFound(`Saved query ${c.req.param('id')} not found`);
    return c.json({ ok: true });
  });

  return app;
}

/** History listing, mounted under `/api/history`. Owner-scoped. */
export function historyRoutes(services: Services): App {
  const app: App = new Hono<{ Variables: AuthVariables }>();

  app.get('/', (c) => {
    const stateRaw = c.req.query('state');
    const stateParsed = stateRaw ? queryStateSchema.safeParse(stateRaw) : undefined;
    if (stateRaw && stateParsed && !stateParsed.success) {
      throw AppError.badRequest(`Invalid state filter: ${stateRaw}`, 'VALIDATION_ERROR');
    }
    return c.json(
      services.history.list(c.var.principal.user, {
        offset: intParam(c.req.query('offset'), 0),
        limit: intParam(c.req.query('limit'), 50),
        state: stateParsed?.success ? stateParsed.data : undefined,
      }),
    );
  });

  return app;
}

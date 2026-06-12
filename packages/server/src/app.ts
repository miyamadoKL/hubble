import { Hono } from 'hono';
import { apiRoutes, type MeResponse } from '@hubble/contracts';
import { loadServerConfig, toAppConfig } from './config';
import { openDatabase } from './db';
import { buildServices, type BuildServicesOptions, type Services } from './services';
import { AppError, toErrorResponse } from './errors';
import { authMiddleware, type AuthVariables, type RemoteAddressFn } from './auth/middleware';
import { metadataRoutes } from './http/metadataRoutes';
import { queryRoutes } from './http/queryRoutes';
import { historyRoutes, notebookRoutes, savedQueryRoutes } from './http/storeRoutes';
import { scheduleRoutes } from './http/scheduleRoutes';
import { registerStaticServing } from './http/staticRoutes';

export interface AppDeps {
  services: Services;
  /** Override the remote-address source for the auth middleware (tests). */
  remoteAddress?: RemoteAddressFn;
}

/**
 * Build the `Services` graph using the configured persistence backend and the
 * default (env-derived) config, applying migrations. Convenience for
 * `index.ts`.
 */
export async function defaultServices(options: BuildServicesOptions = {}): Promise<Services> {
  const config = loadServerConfig();
  const db = await openDatabase(config.database);
  return buildServices(config, db, options);
}

/**
 * Build the Hono app wiring every API route (design.md §7). All handlers throw
 * `AppError` on failure; the error handler renders the `{ error }` envelope.
 */
export function createApp(deps: AppDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const { services } = deps;

  // healthz is always public (design.md §11): it must answer before auth.
  app.get(apiRoutes.healthz(), (c) => c.json({ status: 'ok' }));

  // Authentication gate for every other /api route (design.md §11). In `none`
  // mode it transparently sets the technical principal; in `proxy` mode it
  // resolves the SSO principal or returns 401 UNAUTHENTICATED.
  app.use('/api/*', (c, next) =>
    authMiddleware({
      auth: services.config.auth,
      noneModeUser: services.config.trino.user,
      remoteAddress: deps.remoteAddress,
    })(c, next),
  );

  app.get(apiRoutes.config(), (c) => c.json(toAppConfig(services.config)));
  app.get(apiRoutes.me(), (c) => {
    const principal = c.var.principal;
    const me: MeResponse = {
      user: principal.user,
      authMode: services.config.auth.mode,
      ...(principal.email ? { email: principal.email } : {}),
    };
    return c.json(me);
  });

  // Mount domain routers. Order matters: more specific prefixes first.
  app.route('/api/queries', queryRoutes(services));
  app.route('/api/notebooks', notebookRoutes(services));
  app.route('/api/saved-queries', savedQueryRoutes(services));
  app.route('/api/history', historyRoutes(services));
  app.route('/api/schedules', scheduleRoutes(services));
  // Metadata router owns `/catalogs/...` and `/metadata/refresh` under `/api`.
  app.route('/api', metadataRoutes(services));

  // 404 for unknown /api routes (rendered as the error envelope below). This is
  // registered before static serving so an unknown `/api/*` path always yields
  // the JSON error envelope, never the SPA fallback below.
  app.all('/api/*', () => {
    throw AppError.notFound('Not found');
  });

  // Static web app + SPA fallback (design.md §3 deployment). Only enabled when
  // STATIC_DIR is configured; never serves `/api/*` (handled above). Auth is
  // unaffected — assets are public and the middleware is mounted under `/api`.
  if (services.config.staticDir) {
    registerStaticServing(app, services.config.staticDir);
  }

  // Uniform error envelope (design.md §7).
  app.onError((err, c) => {
    const { status, detail } = toErrorResponse(err);
    return c.json({ error: detail }, status as 400);
  });

  return app;
}

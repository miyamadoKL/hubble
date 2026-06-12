import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Context, Hono, MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { AuthVariables } from '../auth/middleware';

/** Cache-Control for fingerprinted assets (Vite emits hashed file names). */
const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Cache-Control for the SPA entrypoint — always revalidate. */
const NO_CACHE = 'no-cache';

/**
 * Decide the Cache-Control for a resolved file path. The SPA shell
 * (`index.html`) must never be cached so a deploy is picked up immediately;
 * hashed assets under the build output are immutable.
 */
export function cacheControlFor(resolvedPath: string): string {
  return /(?:^|[/\\])index\.html$/.test(resolvedPath) ? NO_CACHE : IMMUTABLE;
}

/**
 * `serveStatic`'s `root` is resolved relative to `process.cwd()`. Normalise an
 * absolute `STATIC_DIR` so an absolute deploy path (e.g. `/opt/hubble/web/dist`)
 * works regardless of where the process runs.
 */
function toServeStaticRoot(staticDir: string): string {
  return isAbsolute(staticDir) ? resolve(staticDir) : staticDir;
}

// `serveStatic` builds the Response inside `c.body()` *before* it calls
// `onFound`, so headers set in `onFound` never land on the returned Response.
// We instead stash the resolved path on the context in `onFound`, then stamp
// the Cache-Control onto `c.res` after the inner handler finalizes.
const RESOLVED_PATH = '__hubbleStaticPath';

function rememberPath(path: string, c: Context): void {
  c.set(RESOLVED_PATH, path);
}

/** Wrap a serveStatic handler so the served file gets the right Cache-Control. */
function withCacheControl(
  inner: MiddlewareHandler,
  cacheFor: (path: string) => string,
): MiddlewareHandler {
  return async (c, next) => {
    // serveStatic returns its Response when it serves a file; preserve it so
    // Hono treats the request as finalized.
    const result = await inner(c, next);
    const path = c.get(RESOLVED_PATH) as string | undefined;
    if (result instanceof Response && path !== undefined) {
      result.headers.set('Cache-Control', cacheFor(path));
    }
    return result;
  };
}

/**
 * Register static file serving + SPA fallback for the built web app
 * (design.md §3 deployment / operations). When `staticDir` is set:
 *
 *  - `GET`/`HEAD` for a matching file under `staticDir` is served with an
 *    appropriate Cache-Control (immutable for hashed assets, no-cache for
 *    `index.html`).
 *  - any other non-`/api` path falls back to `index.html` so client-side
 *    routing works on hard refresh / deep links.
 *
 * `/api/*` is never touched here: this is mounted *after* the API routers and
 * the `/api/*` catch-all, so only non-API paths reach it. Auth is unaffected —
 * static assets are public, as required by §11.
 */
export function registerStaticServing(
  app: Hono<{ Variables: AuthVariables }>,
  staticDir: string,
): void {
  const root = toServeStaticRoot(staticDir);
  const indexPath = join(root, 'index.html');

  // Real files first: serveStatic resolves the request path under `root`.
  app.use('*', withCacheControl(serveStatic({ root, onFound: rememberPath }), cacheControlFor));

  // SPA fallback: any GET/HEAD that didn't match a file or an /api route gets
  // the app shell. `serveStatic` with a fixed `path` always serves index.html.
  const serveIndex = withCacheControl(
    serveStatic({ path: indexPath, onFound: rememberPath }),
    () => NO_CACHE,
  );
  app.get('*', serveIndex);
  app.on('HEAD', '*', serveIndex);
}

/** Warn (don't crash) if the configured static dir is missing at startup. */
export function staticDirExists(staticDir: string): boolean {
  return existsSync(toServeStaticRoot(staticDir));
}

/**
 * GitHub 連携 API ルーター。
 *
 * OAuth 接続、ドキュメント push、PR 作成、承認状態取得を提供する。
 * `/api/github` 配下にマウントされる。
 */
import { Hono } from 'hono';
import {
  documentGitTypeSchema,
  githubDocumentPrRequestSchema,
  githubDocumentPushRequestSchema,
  githubDocumentPrResponseSchema,
  githubDocumentPushResponseSchema,
  githubDocumentStatusResponseSchema,
  githubStatusResponseSchema,
} from '@hubble/contracts';
import type { Services } from '../services';
import type { AuthVariables } from '../auth/middleware';
import { AppError } from '../errors';
import { parseJsonBody } from './validate';
import { createOAuthState, verifyOAuthState } from '../github/state';

type App = Hono<{ Variables: AuthVariables }>;

function assertGithubEnabled(services: Services): void {
  if (!services.github) {
    throw new AppError(404, { code: 'GITHUB_DISABLED', message: 'GitHub integration is disabled' });
  }
}

/**
 * GitHub 連携 API ルーターを生成する。
 * @param services - DI コンテナ。
 */
export function githubRoutes(services: Services): App {
  const app = new Hono<{ Variables: AuthVariables }>();

  app.use('*', async (_c, next) => {
    assertGithubEnabled(services);
    await next();
  });

  app.get('/status', async (c) => {
    const principal = c.var.principal;
    const status = await services.github!.getGlobalStatus(principal.user);
    return c.json(githubStatusResponseSchema.parse(status));
  });

  app.get('/connect', (c) => {
    const principal = c.var.principal;
    const config = services.config.github;
    const now = services.githubNow?.() ?? Date.now();
    const state = createOAuthState(config.tokenEncryptionKey!, principal.user, now);
    const url = new URL('https://github.com/login/oauth/authorize');
    url.searchParams.set('client_id', config.clientId!);
    url.searchParams.set('state', state);
    return c.redirect(url.toString(), 302);
  });

  app.get('/callback', async (c) => {
    const principal = c.var.principal;
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state) {
      return c.redirect('/?github_error=missing_code_or_state', 302);
    }
    const config = services.config.github;
    const now = services.githubNow?.() ?? Date.now();
    if (!verifyOAuthState(config.tokenEncryptionKey!, state, principal.user, now)) {
      return c.redirect('/?github_error=invalid_state', 302);
    }
    try {
      await services.github!.connect(principal.user, code);
      return c.redirect('/', 302);
    } catch (err) {
      const message = err instanceof AppError ? err.detail.message : 'connect_failed';
      return c.redirect(`/?github_error=${encodeURIComponent(message)}`, 302);
    }
  });

  app.delete('/connection', async (c) => {
    await services.github!.disconnect(c.var.principal.user);
    return c.body(null, 204);
  });

  app.get('/documents/:type/:id/status', async (c) => {
    const type = documentGitTypeSchema.parse(c.req.param('type'));
    const id = c.req.param('id');
    const status = await services.github!.getStatus(c.var.principal, type, id);
    return c.json(githubDocumentStatusResponseSchema.parse(status));
  });

  app.post('/documents/:type/:id/push', async (c) => {
    const type = documentGitTypeSchema.parse(c.req.param('type'));
    const id = c.req.param('id');
    const body = await parseJsonBody(c, githubDocumentPushRequestSchema);
    const result = await services.github!.push(c.var.principal, type, id, body);
    return c.json(githubDocumentPushResponseSchema.parse(result));
  });

  app.post('/documents/:type/:id/pr', async (c) => {
    const type = documentGitTypeSchema.parse(c.req.param('type'));
    const id = c.req.param('id');
    const body = await parseJsonBody(c, githubDocumentPrRequestSchema);
    const result = await services.github!.createPullRequest(c.var.principal, type, id, body);
    return c.json(githubDocumentPrResponseSchema.parse(result));
  });

  return app;
}

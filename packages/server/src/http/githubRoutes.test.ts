import { describe, expect, it } from 'vitest';
import {
  apiRoutes,
  githubDocumentPrResponseSchema,
  githubDocumentPushResponseSchema,
  githubDocumentStatusResponseSchema,
  githubStatusResponseSchema,
} from '@hubble/contracts';
import { createTestContext } from '../test/harness';
import { type GithubClient } from '../github/client';
import { createOAuthState } from '../github/state';

const KEY = Buffer.alloc(32, 3);
const GITHUB_ENV = {
  GITHUB_REPO: 'acme/hubble-docs',
  GITHUB_APP_CLIENT_ID: 'client-id',
  GITHUB_APP_CLIENT_SECRET: 'client-secret',
  GITHUB_TOKEN_ENCRYPTION_KEY: KEY.toString('base64'),
};

class RouteFakeGithubClient implements GithubClient {
  readonly branches = new Map<string, string>([['main', 'base-sha']]);
  readonly files = new Map<string, { contentText: string; sha: string }>();
  exchangeCount = 0;

  async exchangeCode(): Promise<{ accessToken: string }> {
    this.exchangeCount += 1;
    return { accessToken: 'access-token' };
  }

  async refreshAccessToken(): Promise<{ accessToken: string }> {
    return { accessToken: 'access-token' };
  }

  async getAuthenticatedUser(): Promise<{ login: string }> {
    return { login: 'octo-user' };
  }

  async getBranchHeadSha(_token: string, _repo: string, branch: string): Promise<string | null> {
    return this.branches.get(branch) ?? null;
  }

  async createBranch(
    _token: string,
    _repo: string,
    branch: string,
    fromSha: string,
  ): Promise<void> {
    this.branches.set(branch, fromSha);
  }

  async getFile(
    _token: string,
    _repo: string,
    path: string,
    ref: string,
  ): Promise<{ contentText: string; sha: string } | null> {
    return this.files.get(`${ref}:${path}`) ?? null;
  }

  async putFile(
    _token: string,
    _repo: string,
    params: { path: string; branch: string; contentText: string; sha?: string },
  ): Promise<{ commitSha: string }> {
    const sha = `commit-${params.path}`;
    this.files.set(`${params.branch}:${params.path}`, { contentText: params.contentText, sha });
    this.branches.set(params.branch, sha);
    return { commitSha: sha };
  }

  async createPullRequest(): Promise<{ number: number; url: string }> {
    return { number: 7, url: 'https://github.com/acme/hubble-docs/pull/7' };
  }

  async listPullRequests(): Promise<Array<{ number: number; url: string; state: string }>> {
    return [];
  }
}

function jsonHeaders(): Record<string, string> {
  return { 'content-type': 'application/json' };
}

describe('github routes', () => {
  it('returns 404 when GitHub integration is disabled', async () => {
    const ctx = await createTestContext();
    const res = await ctx.app.request(apiRoutes.githubStatus());
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('GITHUB_DISABLED');
    await ctx.services.shutdown();
  });

  it('returns status and redirects connect with signed state', async () => {
    const fixedNow = Date.parse('2026-01-01T00:00:00.000Z');
    const ctx = await createTestContext({
      env: GITHUB_ENV,
      githubClient: new RouteFakeGithubClient(),
      configOverrides: {
        github: {
          enabled: true,
          repo: GITHUB_ENV.GITHUB_REPO,
          defaultBranch: 'main',
          clientId: GITHUB_ENV.GITHUB_APP_CLIENT_ID,
          clientSecret: GITHUB_ENV.GITHUB_APP_CLIENT_SECRET,
          tokenEncryptionKey: KEY,
          governance: 'off',
          statusTtlSeconds: 120,
        },
      },
    });
    ctx.services.githubNow = () => fixedNow;

    const statusRes = await ctx.app.request(apiRoutes.githubStatus());
    expect(statusRes.status).toBe(200);
    const status = githubStatusResponseSchema.parse(await statusRes.json());
    expect(status.enabled).toBe(true);
    expect(status.connected).toBe(false);
    expect(status.repo).toBe(GITHUB_ENV.GITHUB_REPO);

    const connectRes = await ctx.app.request(apiRoutes.githubConnect(), { redirect: 'manual' });
    expect(connectRes.status).toBe(302);
    const location = connectRes.headers.get('location');
    expect(location).toContain('https://github.com/login/oauth/authorize');
    const state = new URL(location!).searchParams.get('state');
    expect(state).toBeTruthy();
    expect(createOAuthState(KEY, 'admin', fixedNow)).toBe(state);

    const badStateRes = await ctx.app.request(
      `${apiRoutes.githubConnect().replace('/connect', '/callback')}?code=abc&state=tampered`,
      {
        redirect: 'manual',
      },
    );
    expect(badStateRes.status).toBe(302);
    expect(badStateRes.headers.get('location')).toBe('/?github_error=invalid_state');
    await ctx.services.shutdown();
  });

  it('handles callback, push, pr, and audit records', async () => {
    const fixedNow = Date.parse('2026-01-01T00:00:00.000Z');
    const githubClient = new RouteFakeGithubClient();
    const ctx = await createTestContext({
      env: GITHUB_ENV,
      githubClient,
      configOverrides: {
        github: {
          enabled: true,
          repo: GITHUB_ENV.GITHUB_REPO,
          defaultBranch: 'main',
          clientId: GITHUB_ENV.GITHUB_APP_CLIENT_ID,
          clientSecret: GITHUB_ENV.GITHUB_APP_CLIENT_SECRET,
          tokenEncryptionKey: KEY,
          governance: 'off',
          statusTtlSeconds: 120,
        },
      },
    });
    ctx.services.githubNow = () => fixedNow;
    const state = createOAuthState(KEY, 'admin', fixedNow);

    const callbackRes = await ctx.app.request(
      `/api/github/callback?code=oauth-code&state=${encodeURIComponent(state)}`,
      { redirect: 'manual' },
    );
    expect(callbackRes.status).toBe(302);
    expect(callbackRes.headers.get('location')).toBe('/');

    const createRes = await ctx.app.request('/api/saved-queries', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ name: 'Q', statement: 'SELECT 1' }),
    });
    const saved = (await createRes.json()) as { id: string };

    const pushRes = await ctx.app.request(apiRoutes.githubDocumentPush('saved_query', saved.id), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });
    expect(pushRes.status).toBe(200);
    const pushBody = githubDocumentPushResponseSchema.parse(await pushRes.json());
    expect(pushBody.compareUrl).toContain('compare/main...');

    const statusRes = await ctx.app.request(
      apiRoutes.githubDocumentStatus('saved_query', saved.id),
    );
    const statusBody = githubDocumentStatusResponseSchema.parse(await statusRes.json());
    expect(statusBody.status).toBe('in_review');
    expect(statusBody.connected).toBe(true);

    const prRes = await ctx.app.request(apiRoutes.githubDocumentPr('saved_query', saved.id), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({}),
    });
    expect(prRes.status).toBe(200);
    githubDocumentPrResponseSchema.parse(await prRes.json());

    const audit = await ctx.services.audit.listForTest();
    expect(audit.some((row) => row.action === 'github.connect')).toBe(true);
    expect(audit.some((row) => row.action === 'github.push')).toBe(true);
    expect(audit.some((row) => row.action === 'github.pr.create')).toBe(true);
    await ctx.services.shutdown();
  });
});

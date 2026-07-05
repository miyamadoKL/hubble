import { describe, expect, it } from 'vitest';
import { AppError } from '../errors';
import { GithubApiClient, GithubPullRequestExistsError, type GithubClient } from './client';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeClient(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
): GithubClient {
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
  return new GithubApiClient({
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetchImpl,
  });
}

describe('GithubApiClient', () => {
  it('exchanges OAuth code', async () => {
    const client = makeClient((url, init) => {
      expect(url).toBe('https://github.com/login/oauth/access_token');
      expect(init?.method).toBe('POST');
      return jsonResponse({ access_token: 'token', refresh_token: 'refresh', expires_in: 3600 });
    });
    const token = await client.exchangeCode('code');
    expect(token.accessToken).toBe('token');
    expect(token.refreshToken).toBe('refresh');
    expect(token.expiresAt).toBeDefined();
  });

  it('maps 401 to GITHUB_TOKEN_INVALID', async () => {
    const client = makeClient(() => jsonResponse({ message: 'Bad credentials' }, 401));
    await expect(client.getAuthenticatedUser('bad')).rejects.toMatchObject({
      status: 401,
      detail: { code: 'GITHUB_TOKEN_INVALID' },
    });
  });

  it('maps rate limit 403 to 429', async () => {
    const client = makeClient(() =>
      jsonResponse({ message: 'rate limit' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '9999999999',
      }),
    );
    await expect(client.getAuthenticatedUser('token')).rejects.toMatchObject({
      status: 429,
      detail: { code: 'GITHUB_ERROR' },
    });
  });

  it('returns null for missing branch or file', async () => {
    const client = makeClient((url) => {
      if (url.includes('/git/ref/heads/missing')) return jsonResponse({}, 404);
      if (url.includes('/contents/missing.sql')) return jsonResponse({}, 404);
      return jsonResponse({ object: { sha: 'abc' } });
    });
    await expect(client.getBranchHeadSha('token', 'org/repo', 'missing')).resolves.toBeNull();
    await expect(client.getFile('token', 'org/repo', 'missing.sql', 'main')).resolves.toBeNull();
  });

  it('throws GithubPullRequestExistsError on 422 create', async () => {
    const client = makeClient((url, init) => {
      if (url.endsWith('/pulls') && init?.method === 'POST') {
        return jsonResponse({ message: 'already exists' }, 422);
      }
      return jsonResponse([]);
    });
    await expect(
      client.createPullRequest('token', 'org/repo', {
        head: 'feature',
        base: 'main',
        title: 'Update',
        body: 'body',
      }),
    ).rejects.toBeInstanceOf(GithubPullRequestExistsError);
  });

  it('maps other failures to GITHUB_ERROR', async () => {
    const client = makeClient(() => jsonResponse({ message: 'boom' }, 500));
    await expect(client.getAuthenticatedUser('token')).rejects.toBeInstanceOf(AppError);
    await expect(client.getAuthenticatedUser('token')).rejects.toMatchObject({
      status: 502,
      detail: { code: 'GITHUB_ERROR' },
    });
  });
});

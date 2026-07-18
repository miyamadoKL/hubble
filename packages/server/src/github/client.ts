/**
 * GitHub.com REST API クライアント。
 *
 * fetchImpl を注入可能にし、テストではフェイク fetch で差し替える。
 * Octokit は使わず素の fetch のみで GitHub API を叩く。
 *
 * transport だけを `@octokit/request` へ移す vertical slice を試したが、401、
 * rate limit、404 の null 化、422 の pull request 重複判定、Base64 content の
 * 扱いを既存の error contract に戻す adapter が必要になり、実装行が正味で増えた
 * (315 行から 333 行)。GitHub error contract を変える製品判断がない限り、raw fetch
 * を維持する。
 */
import { AppError } from '../errors';

const GITHUB_API = 'https://api.github.com';
const GITHUB_OAUTH = 'https://github.com/login/oauth/access_token';

const DEFAULT_HEADERS = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'hubble',
} as const;

/** OAuth token 交換/更新の応答。expiresAt は access token の失効予定時刻。 */
export interface GithubTokenResponse {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
}

/** ファイル更新 (PUT contents) のパラメータ。sha 省略時は新規作成として扱う。 */
export interface GithubPutFileParams {
  path: string;
  branch: string;
  contentText: string;
  message: string;
  sha?: string;
}

export interface GithubPullRequestParams {
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface GithubPullRequestSummary {
  number: number;
  url: string;
  state: string;
}

/** createPullRequest が 422 (既存 PR) のときに投げる。 */
export class GithubPullRequestExistsError extends Error {
  constructor(message = 'Pull request already exists') {
    super(message);
    this.name = 'GithubPullRequestExistsError';
  }
}

/** テストでフェイク可能な GitHub API クライアント契約。 */
export interface GithubClient {
  exchangeCode(code: string): Promise<GithubTokenResponse>;
  refreshAccessToken(refreshToken: string): Promise<GithubTokenResponse>;
  getAuthenticatedUser(token: string): Promise<{ login: string }>;
  getBranchHeadSha(token: string, repo: string, branch: string): Promise<string | null>;
  createBranch(token: string, repo: string, branch: string, fromSha: string): Promise<void>;
  getFile(
    token: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<{ contentText: string; sha: string } | null>;
  putFile(token: string, repo: string, params: GithubPutFileParams): Promise<{ commitSha: string }>;
  createPullRequest(
    token: string,
    repo: string,
    params: GithubPullRequestParams,
  ): Promise<{ number: number; url: string }>;
  listPullRequests(token: string, repo: string, head: string): Promise<GithubPullRequestSummary[]>;
}

/** fetchImpl はテスト用の差し替え口。省略時はグローバル fetch を使う。 */
export interface GithubClientOptions {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}

/**
 * GitHub.com 向け REST API クライアント実装。
 */
export class GithubApiClient implements GithubClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GithubClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async exchangeCode(code: string): Promise<GithubTokenResponse> {
    return this.requestToken({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      code,
    });
  }

  async refreshAccessToken(refreshToken: string): Promise<GithubTokenResponse> {
    return this.requestToken({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
  }

  async getAuthenticatedUser(token: string): Promise<{ login: string }> {
    const data = await this.apiJson<{ login: string }>(token, '/user');
    return { login: data.login };
  }

  async getBranchHeadSha(token: string, repo: string, branch: string): Promise<string | null> {
    const res = await this.apiFetch(
      token,
      `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`,
    );
    if (res.status === 404) return null;
    await this.assertOk(res);
    const data = (await res.json()) as { object?: { sha?: string } };
    return data.object?.sha ?? null;
  }

  async createBranch(token: string, repo: string, branch: string, fromSha: string): Promise<void> {
    const res = await this.apiFetch(token, `/repos/${repo}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: `refs/heads/${branch}`,
        sha: fromSha,
      }),
    });
    await this.assertOk(res);
  }

  async getFile(
    token: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<{ contentText: string; sha: string } | null> {
    const encodedPath = path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const res = await this.apiFetch(
      token,
      `/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    );
    if (res.status === 404) return null;
    await this.assertOk(res);
    const data = (await res.json()) as { content?: string; sha?: string; encoding?: string };
    if (data.encoding !== 'base64' || !data.content || !data.sha) {
      throw githubError('Unexpected GitHub contents response');
    }
    const contentText = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return { contentText, sha: data.sha };
  }

  async putFile(
    token: string,
    repo: string,
    params: GithubPutFileParams,
  ): Promise<{ commitSha: string }> {
    const encodedPath = params.path
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    const body: Record<string, unknown> = {
      message: params.message,
      content: Buffer.from(params.contentText, 'utf8').toString('base64'),
      branch: params.branch,
    };
    if (params.sha) body.sha = params.sha;
    const res = await this.apiFetch(token, `/repos/${repo}/contents/${encodedPath}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    });
    await this.assertOk(res);
    const data = (await res.json()) as { commit?: { sha?: string } };
    const commitSha = data.commit?.sha;
    if (!commitSha) {
      throw githubError('GitHub put contents response missing commit sha');
    }
    return { commitSha };
  }

  async createPullRequest(
    token: string,
    repo: string,
    params: GithubPullRequestParams,
  ): Promise<{ number: number; url: string }> {
    const res = await this.apiFetch(token, `/repos/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({
        title: params.title,
        body: params.body,
        head: params.head,
        base: params.base,
      }),
    });
    if (res.status === 422) {
      throw new GithubPullRequestExistsError();
    }
    await this.assertOk(res);
    const data = (await res.json()) as { number?: number; html_url?: string };
    if (!data.number || !data.html_url) {
      throw githubError('GitHub create pull response missing fields');
    }
    return { number: data.number, url: data.html_url };
  }

  async listPullRequests(
    token: string,
    repo: string,
    head: string,
  ): Promise<GithubPullRequestSummary[]> {
    const res = await this.apiFetch(
      token,
      `/repos/${repo}/pulls?head=${encodeURIComponent(head)}&state=open`,
    );
    await this.assertOk(res);
    const data = (await res.json()) as Array<{
      number?: number;
      html_url?: string;
      state?: string;
    }>;
    return data
      .filter((item) => item.number && item.html_url && item.state)
      .map((item) => ({
        number: item.number!,
        url: item.html_url!,
        state: item.state!,
      }));
  }

  private async requestToken(body: Record<string, string>): Promise<GithubTokenResponse> {
    const res = await this.fetchImpl(GITHUB_OAUTH, {
      method: 'POST',
      headers: {
        ...DEFAULT_HEADERS,
        Accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    await this.assertOk(res);
    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw githubError('GitHub OAuth response missing access_token');
    }
    const expiresAt =
      typeof data.expires_in === 'number'
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : undefined;
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt,
    };
  }

  private async apiJson<T>(token: string, path: string): Promise<T> {
    const res = await this.apiFetch(token, path);
    await this.assertOk(res);
    return (await res.json()) as T;
  }

  private apiFetch(token: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(DEFAULT_HEADERS)) {
      headers.set(key, value);
    }
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body && !headers.has('content-type')) {
      headers.set('content-type', 'application/json');
    }
    return this.fetchImpl(`${GITHUB_API}${path}`, { ...init, headers });
  }

  private async assertOk(res: Response): Promise<void> {
    if (res.ok) return;
    if (res.status === 401) {
      throw new AppError(401, {
        code: 'GITHUB_TOKEN_INVALID',
        message: 'GitHub token is invalid or expired',
      });
    }
    if (res.status === 403) {
      const remaining = res.headers.get('x-ratelimit-remaining');
      const reset = res.headers.get('x-ratelimit-reset');
      if (remaining === '0' && reset) {
        throw new AppError(429, {
          code: 'GITHUB_ERROR',
          message: 'GitHub API rate limit exceeded',
        });
      }
    }
    let message = `GitHub API returned ${res.status}`;
    try {
      const data = (await res.json()) as { message?: string };
      if (data.message) message = data.message;
    } catch {
      // JSON でないレスポンスは既定メッセージのまま。
    }
    throw githubError(message);
  }
}

function githubError(message: string): AppError {
  return new AppError(502, { code: 'GITHUB_ERROR', message });
}

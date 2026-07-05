import { describe, expect, it } from 'vitest';
import { AuditLogger, AuditRepository } from '../audit';
import { loadServerConfig } from '../config';
import type { Principal } from '../auth/principal';
import { NotebookRepository } from '../store/notebooks';
import { SavedQueryRepository } from '../store/savedQueries';
import { DocumentShareRepository } from '../store/documentShares';
import { WorkflowRepository } from '../store/workflows';
import { dbBackends } from '../test/dbBackends';
import { savedQueryToContent } from './canonical';
import { GithubPullRequestExistsError, type GithubClient } from './client';
import { DocumentGitLinkRepository, GithubConnectionRepository } from './store';
import { GithubSyncService } from './syncService';

const KEY = Buffer.alloc(32, 2);
const REPO = 'acme/hubble-docs';
const DEFAULT_BRANCH = 'main';

class FakeGithubClient implements GithubClient {
  readonly branches = new Map<string, string>();
  readonly files = new Map<string, { contentText: string; sha: string }>();
  readonly pulls = new Map<string, { number: number; url: string; state: string }>();
  headSha = 'base-sha';
  putCount = 0;
  createBranchCalls = 0;

  constructor() {
    this.branches.set(DEFAULT_BRANCH, this.headSha);
  }

  async exchangeCode(): Promise<{ accessToken: string; refreshToken?: string }> {
    return { accessToken: 'access-token', refreshToken: 'refresh-token' };
  }

  async refreshAccessToken(): Promise<{ accessToken: string; refreshToken?: string }> {
    return { accessToken: 'access-token-refreshed', refreshToken: 'refresh-token' };
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
    this.createBranchCalls += 1;
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
    this.putCount += 1;
    const sha = `sha-${this.putCount}`;
    this.files.set(`${params.branch}:${params.path}`, { contentText: params.contentText, sha });
    this.branches.set(params.branch, sha);
    return { commitSha: sha };
  }

  async createPullRequest(
    _token: string,
    _repo: string,
    params: { head: string; base: string; title: string; body: string },
  ): Promise<{ number: number; url: string }> {
    const key = `${params.head}->${params.base}`;
    if (this.pulls.has(key)) {
      throw new GithubPullRequestExistsError();
    }
    const pr = { number: 42, url: 'https://github.com/acme/hubble-docs/pull/42', state: 'open' };
    this.pulls.set(key, pr);
    return pr;
  }

  async listPullRequests(
    _token: string,
    _repo: string,
    head: string,
  ): Promise<Array<{ number: number; url: string; state: string }>> {
    const branch = head.split(':')[1] ?? head;
    const pr = this.pulls.get(`${branch}->${DEFAULT_BRANCH}`);
    return pr ? [pr] : [];
  }
}

function buildService(
  db: Awaited<ReturnType<(typeof dbBackends)[0]['open']>>,
  client: FakeGithubClient,
  now = () => Date.now(),
) {
  const shares = new DocumentShareRepository(db);
  const savedQueries = new SavedQueryRepository(db, shares);
  const notebooks = new NotebookRepository(db, shares);
  const workflows = new WorkflowRepository(db);
  const audit = new AuditLogger(new AuditRepository(db));
  const connections = new GithubConnectionRepository(db);
  const links = new DocumentGitLinkRepository(db);
  const config = loadServerConfig({
    GITHUB_REPO: REPO,
    GITHUB_APP_CLIENT_ID: 'cid',
    GITHUB_APP_CLIENT_SECRET: 'sec',
    GITHUB_TOKEN_ENCRYPTION_KEY: KEY.toString('base64'),
  }).github;
  const service = new GithubSyncService({
    config,
    client,
    connections,
    links,
    savedQueries,
    notebooks,
    workflows,
    audit,
    encryptionKey: KEY,
    now,
  });
  return { service, savedQueries, links, shares };
}

const principalAlice = {
  user: 'alice',
  role: { name: 'admin', permissions: new Set(['query.write'] as const) },
  groups: [] as string[],
} as Principal;
const accessorAlice = { user: 'alice', groups: [] as string[], role: 'admin' };

describe.each(dbBackends)('GithubSyncService ($name)', ({ open }) => {
  it('connects and disconnects GitHub account', async () => {
    const db = await open();
    const client = new FakeGithubClient();
    const { service } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    expect((await service.getGlobalStatus('alice')).connected).toBe(true);
    await service.disconnect('alice');
    expect((await service.getGlobalStatus('alice')).connected).toBe(false);
    await db.close();
  });

  it('pushes saved query to feature branch and updates existing file sha', async () => {
    const db = await open();
    const client = new FakeGithubClient();
    const { service, savedQueries } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    const first = await service.push(principalAlice, 'saved_query', saved.id, {});
    expect(first.branch).toContain('hubble/alice/saved_query-');
    expect(client.createBranchCalls).toBe(1);

    await savedQueries.update(accessorAlice, saved.id, {
      name: 'Q',
      description: '',
      statement: 'SELECT 2',
      isFavorite: false,
    });
    const second = await service.push(principalAlice, 'saved_query', saved.id, {});
    expect(second.commitSha).not.toBe(first.commitSha);
    expect(client.putCount).toBe(2);
    await db.close();
  });

  it('reports status transitions and uses TTL cache', async () => {
    const db = await open();
    const client = new FakeGithubClient();
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const { service, savedQueries } = buildService(db, client, () => now);
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });

    const unlinked = await service.getStatus(principalAlice, 'saved_query', saved.id);
    expect(unlinked.status).toBe('unlinked');

    await service.push(principalAlice, 'saved_query', saved.id, {});
    const inReview = await service.getStatus(principalAlice, 'saved_query', saved.id);
    expect(inReview.status).toBe('in_review');

    const doc = await savedQueries.get(accessorAlice, saved.id);
    const content = savedQueryToContent(doc!);
    client.files.set(`${DEFAULT_BRANCH}:saved-queries/${saved.id}.sql`, {
      contentText: content,
      sha: 'approved-sha',
    });
    now += 130_000;
    const approved = await service.getStatus(principalAlice, 'saved_query', saved.id);
    expect(approved.status).toBe('approved');

    const filesBefore = client.files.size;
    now += 30_000;
    const cached = await service.getStatus(principalAlice, 'saved_query', saved.id);
    expect(cached.status).toBe('approved');
    expect(cached.stale).toBeUndefined();

    now += 130_000;
    await service.getStatus(principalAlice, 'saved_query', saved.id);
    expect(client.files.size).toBeGreaterThanOrEqual(filesBefore);

    await savedQueries.update(accessorAlice, saved.id, {
      name: 'Q',
      description: '',
      statement: 'SELECT 9',
      isFavorite: false,
    });
    const modified = await service.getStatus(principalAlice, 'saved_query', saved.id);
    expect(modified.status).toBe('modified');
    await db.close();
  });

  it('skips verification when not connected but still returns status', async () => {
    const db = await open();
    const client = new FakeGithubClient();
    const { service, savedQueries, links } = buildService(db, client);
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    await links.upsert('saved_query', saved.id, {
      path: `saved-queries/${saved.id}.sql`,
      branch: 'hubble/alice/saved_query-sq_x',
      lastPushedHash: 'deadbeef',
    });
    const status = await service.getStatus(principalAlice, 'saved_query', saved.id);
    expect(status.connected).toBe(false);
    expect(status.status).toBe('modified');
    await db.close();
  });

  it('creates PR and falls back to existing open PR on 422', async () => {
    const db = await open();
    const client = new FakeGithubClient();
    const { service, savedQueries } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    await service.push(principalAlice, 'saved_query', saved.id, {});
    const first = await service.createPullRequest(principalAlice, 'saved_query', saved.id, {});
    const second = await service.createPullRequest(principalAlice, 'saved_query', saved.id, {});
    expect(second.prNumber).toBe(first.prNumber);
    await db.close();
  });

  it('rejects push from non-owner shared accessor', async () => {
    const db = await open();
    const client = new FakeGithubClient();
    const { service, savedQueries, shares } = buildService(db, client);
    await service.connect('bob', 'oauth-code');
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    await shares.replaceForDocument(
      'saved_query',
      saved.id,
      [{ subjectType: 'user', subjectValue: 'bob', permission: 'edit' }],
      'alice',
    );
    const principalBob = {
      user: 'bob',
      role: { name: 'admin', permissions: new Set(['query.write'] as const) },
      groups: [] as string[],
    } as Principal;
    await expect(service.push(principalBob, 'saved_query', saved.id, {})).rejects.toMatchObject({
      status: 403,
    });
    await db.close();
  });

  it('requires connection before push', async () => {
    const db = await open();
    const client = new FakeGithubClient();
    const { service, savedQueries } = buildService(db, client);
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    await expect(service.push(principalAlice, 'saved_query', saved.id, {})).rejects.toMatchObject({
      status: 401,
      detail: { code: 'GITHUB_NOT_CONNECTED' },
    });
    await db.close();
  });
});

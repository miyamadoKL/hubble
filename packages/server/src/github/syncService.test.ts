import { describe, expect, it } from 'vitest';
import { AuditLogger, AuditRepository } from '../audit';
import { loadServerConfig } from '../config';
import type { Principal } from '../auth/principal';
import { NotebookRepository } from '../store/notebooks';
import { DashboardRepository } from '../store/dashboards';
import { SavedQueryRepository } from '../store/savedQueries';
import { DocumentShareRepository } from '../store/documentShares';
import { WorkflowRepository } from '../store/workflows';
import { AlertRepository } from '../store/alerts';
import type { LoadedRbac } from '../rbac/types';
import { openTestDatabase } from '../test/dbBackends';
import type { SqlDatabase } from '../db/sqlDatabase';
import {
  alertToContent,
  savedQueryToContent,
  contentHash,
  documentPath,
  documentToContent,
} from './canonical';
import { GithubPullRequestExistsError, type GithubClient } from './client';
import { DocumentGitLinkRepository, GithubConnectionRepository } from './store';
import { GithubSyncService } from './syncService';
import { encryptToken } from './crypto';

const KEY = Buffer.alloc(32, 2);
const REPO = 'acme/hubble-docs';
const DEFAULT_BRANCH = 'main';
const TEST_RBAC = {
  roles: new Map([
    [
      'unrestricted',
      { permissions: new Set(['query.write', 'ai.use'] as const), datasources: ['*'] },
    ],
  ]),
  assignments: [],
  defaultRole: 'unrestricted',
} satisfies LoadedRbac;

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
  db: SqlDatabase,
  client: FakeGithubClient,
  now = () => Date.now(),
  configOverrides: Partial<ReturnType<typeof loadServerConfig>['github']> = {},
  serviceDb: SqlDatabase = db,
) {
  const shares = new DocumentShareRepository(db);
  const savedQueries = new SavedQueryRepository(db, shares);
  const notebooks = new NotebookRepository(db, shares);
  const dashboards = new DashboardRepository(db, shares);
  const workflows = new WorkflowRepository(db);
  const alerts = new AlertRepository(db);
  const audit = new AuditLogger(new AuditRepository(db));
  const connections = new GithubConnectionRepository(db);
  const links = new DocumentGitLinkRepository(db);
  const baseConfig = loadServerConfig({
    DATABASE_URL: process.env.TEST_DATABASE_URL,
    GITHUB_REPO: REPO,
    GITHUB_APP_CLIENT_ID: 'cid',
    GITHUB_APP_CLIENT_SECRET: 'sec',
    GITHUB_TOKEN_ENCRYPTION_KEY: KEY.toString('base64'),
  }).github;
  const config = { ...baseConfig, ...configOverrides };
  const service = new GithubSyncService({
    db: serviceDb,
    config,
    client,
    connections,
    links,
    savedQueries,
    notebooks,
    dashboards,
    workflows,
    alerts,
    audit,
    getRbac: () => TEST_RBAC,
    now,
  });
  return {
    service,
    savedQueries,
    notebooks,
    dashboards,
    workflows,
    alerts,
    links,
    connections,
    shares,
    audit,
    config,
  };
}

const principalAlice = {
  user: 'alice',
  role: { name: 'admin', permissions: new Set(['query.write'] as const), datasources: ['*'] },
  groups: [] as string[],
} as Principal;
const accessorAlice = { user: 'alice', groups: [] as string[], role: 'admin' };

function failDocumentGitLinkWrites(db: SqlDatabase): SqlDatabase {
  return {
    query: db.query.bind(db),
    run: db.run.bind(db),
    exec: db.exec.bind(db),
    close: db.close.bind(db),
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: tx.query.bind(tx),
          run: async (sql, params) => {
            if (/\b(?:INSERT INTO|UPDATE) document_git_links\b/.test(sql)) {
              throw new Error('injected link write failure');
            }
            await tx.run(sql, params);
          },
          exec: tx.exec.bind(tx),
          transaction: tx.transaction.bind(tx),
          close: tx.close.bind(tx),
        }),
      ),
  };
}

describe('GithubSyncService', () => {
  it('connects and disconnects GitHub account', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    expect((await service.getGlobalStatus('alice')).connected).toBe(true);
    await service.disconnect('alice');
    expect((await service.getGlobalStatus('alice')).connected).toBe(false);
    await db.close();
  });

  it('rewraps a token encrypted by an old key without refreshing it', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const oldKey = Buffer.alloc(32, 4);
    const keys = new Map([
      ['current', KEY],
      ['old', oldKey],
    ]);
    const { service, connections } = buildService(db, client, undefined, {
      tokenEncryptionKey: KEY,
      tokenEncryptionKeys: { activeKeyId: 'current', keys },
    });
    await connections.upsert('alice', {
      githubLogin: 'octo-user',
      accessTokenEnc: encryptToken({ activeKeyId: 'old', keys }, 'access-token'),
      refreshTokenEnc: null,
      tokenExpiresAt: null,
    });

    await expect(service.getConnection('alice')).resolves.toMatchObject({
      accessToken: 'access-token',
    });
    expect((await connections.get('alice'))?.accessTokenEnc).toMatch(/^v1\.current\./);
    await db.close();
  });

  it('pushes saved query to feature branch and updates existing file sha', async () => {
    const db = await openTestDatabase();
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
    const db = await openTestDatabase();
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
    const db = await openTestDatabase();
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
    const db = await openTestDatabase();
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
    const db = await openTestDatabase();
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
      role: { name: 'admin', permissions: new Set(['query.write'] as const), datasources: ['*'] },
      groups: [] as string[],
    } as Principal;
    await expect(service.push(principalBob, 'saved_query', saved.id, {})).rejects.toMatchObject({
      status: 403,
    });
    await db.close();
  });

  it('requires connection before push', async () => {
    const db = await openTestDatabase();
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

  it('rejects newline metadata before writing a Git file', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', {
      name: 'Broken\nname',
      statement: 'SELECT 1',
    });

    await expect(service.push(principalAlice, 'saved_query', saved.id)).rejects.toMatchObject({
      status: 400,
      detail: { code: 'GITHUB_INVALID_METADATA' },
    });
    expect(client.createBranchCalls).toBe(0);
    expect(client.putCount).toBe(0);
    await db.close();
  });

  it('pullDocument overwrites local content and preserves isFavorite', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, links } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
      isFavorite: true,
    });
    await savedQueries.update(accessorAlice, saved.id, {
      name: 'Q',
      description: '',
      statement: 'SELECT local',
      isFavorite: true,
    });
    const remoteContent = '-- name:   Q  \r\n\r\nSELECT remote   \r\n\r\n';
    const remoteHash = contentHash(remoteContent);
    await links.upsert('saved_query', saved.id, {
      path: documentPath('saved_query', saved.id),
      approvedHash: contentHash(
        savedQueryToContent({ ...saved, statement: 'SELECT local', isFavorite: true }),
      ),
    });
    client.files.set(`${DEFAULT_BRANCH}:saved-queries/${saved.id}.sql`, {
      contentText: remoteContent,
      sha: 'remote-sha',
    });

    const result = await service.pullDocument(principalAlice, 'saved_query', saved.id);
    expect(result).toEqual({ pulled: true, commit: 'remote-sha', status: 'approved' });

    const updated = await savedQueries.get(accessorAlice, saved.id);
    expect(updated?.statement).toBe('SELECT remote');
    expect(updated?.isFavorite).toBe(true);

    const link = await links.get('saved_query', saved.id);
    const canonicalHash = contentHash(documentToContent('saved_query', updated!));
    expect(canonicalHash).not.toBe(remoteHash);
    expect(link?.approvedHash).toBe(canonicalHash);
    expect(link?.lastPushedHash).toBe(canonicalHash);
    expect((await service.getStatus(principalAlice, 'saved_query', saved.id)).status).toBe(
      'approved',
    );
    await db.close();
  });

  it('rolls back the document update when the link update fails', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, links } = buildService(
      db,
      client,
      () => Date.now(),
      {},
      failDocumentGitLinkWrites(db),
    );
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', { name: 'Q', statement: 'SELECT local' });
    const approvedHash = contentHash(savedQueryToContent(saved));
    await links.upsert('saved_query', saved.id, {
      path: documentPath('saved_query', saved.id),
      approvedHash,
    });
    client.files.set(`${DEFAULT_BRANCH}:saved-queries/${saved.id}.sql`, {
      contentText: savedQueryToContent({ ...saved, statement: 'SELECT remote' }),
      sha: 'remote-sha',
    });

    await expect(service.pullDocument(principalAlice, 'saved_query', saved.id)).rejects.toThrow(
      'injected link write failure',
    );
    expect((await savedQueries.get(accessorAlice, saved.id))?.statement).toBe('SELECT local');
    expect((await links.get('saved_query', saved.id))?.approvedHash).toBe(approvedHash);
    await db.close();
  });

  it('pullDocument rejects non-owner and missing link or file', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, links, shares } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
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
      role: { name: 'admin', permissions: new Set(['query.write'] as const), datasources: ['*'] },
      groups: [] as string[],
    } as Principal;

    await expect(service.pullDocument(principalBob, 'saved_query', saved.id)).rejects.toMatchObject(
      {
        status: 403,
      },
    );

    await expect(
      service.pullDocument(principalAlice, 'saved_query', saved.id),
    ).rejects.toMatchObject({
      status: 400,
      detail: { code: 'GITHUB_NOT_LINKED' },
    });

    await links.upsert('saved_query', saved.id, {
      path: documentPath('saved_query', saved.id),
      approvedHash: 'abc',
    });
    await expect(
      service.pullDocument(principalAlice, 'saved_query', saved.id),
    ).rejects.toMatchObject({
      status: 404,
      detail: { code: 'GITHUB_FILE_MISSING' },
    });
    await db.close();
  });

  it('pullDocument preserves workflow enabled flag', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, workflows, links } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const workflow = await workflows.create('alice', {
      name: 'WF',
      datasourceId: 'trino-default',
      enabled: false,
      stages: [{ steps: [{ id: 's1', name: 'S', statement: 'SELECT 1', onFailure: 'stop' }] }],

      principalSnapshot: { user: 'alice' },
    });
    const remoteContent = documentToContent('workflow', {
      ...workflow,
      stages: [{ steps: [{ id: 's1', name: 'S', statement: 'SELECT 2', onFailure: 'stop' }] }],
    });
    await links.upsert('workflow', workflow.id, {
      path: documentPath('workflow', workflow.id),
      approvedHash: contentHash(documentToContent('workflow', workflow)),
    });
    client.files.set(`${DEFAULT_BRANCH}:workflows/${workflow.id}.yaml`, {
      contentText: remoteContent,
      sha: 'wf-sha',
    });

    await service.pullDocument(principalAlice, 'workflow', workflow.id);
    const updated = await workflows.get('alice', workflow.id);
    expect(updated?.stages[0]?.steps[0]?.statement).toBe('SELECT 2');
    expect(updated?.enabled).toBe(false);
    await db.close();
  });

  it('pullDocument preserves an alert webhook URL while applying public notification fields', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, alerts, links } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', { name: 'Metric', statement: 'SELECT 1' });
    const alert = await alerts.create('alice', {
      name: 'Spike',
      savedQueryId: saved.id,
      columnName: 'count',
      op: '>',
      value: '100',
      cron: '0 * * * *',
      notifications: {
        channels: ['webhook'],
        webhookUrl: 'https://secret.example/existing',
      },

      principalSnapshot: { user: 'alice' },
    });
    const remoteContent = alertToContent({
      ...alert,
      notifications: {
        channels: ['webhook', 'email'],
        emailTo: ['new-ops@example.com'],
        webhookUrl: 'https://secret.example/remote',
      },
    });
    expect(remoteContent).not.toContain('webhookUrl');
    expect(remoteContent).not.toContain('https://secret.example/remote');
    await links.upsert('alert', alert.id, {
      path: documentPath('alert', alert.id),
      approvedHash: contentHash(alertToContent(alert)),
    });
    client.files.set(`${DEFAULT_BRANCH}:alerts/${alert.id}.yaml`, {
      contentText: remoteContent,
      sha: 'alert-sha',
    });

    await service.pullDocument(principalAlice, 'alert', alert.id);

    expect((await alerts.getById(alert.id))?.notifications).toEqual({
      channels: ['webhook', 'email'],
      emailTo: ['new-ops@example.com'],
      webhookUrl: 'https://secret.example/existing',
    });
    await db.close();
  });

  it('pullDocument rejects an alert update after saved-query access is revoked', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, alerts, links, shares } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const sharedQuery = await savedQueries.create('bob', {
      name: 'Shared metric',
      statement: 'SELECT 1',
    });
    await shares.replaceForDocument(
      'saved_query',
      sharedQuery.id,
      [{ subjectType: 'user', subjectValue: 'alice', permission: 'view' }],
      'bob',
    );
    const alert = await alerts.create('alice', {
      name: 'Local alert',
      savedQueryId: sharedQuery.id,
      columnName: 'count',
      op: '>',
      value: '100',
      cron: '0 * * * *',

      principalSnapshot: { user: 'alice' },
    });
    const approvedHash = contentHash(alertToContent(alert));
    await links.upsert('alert', alert.id, {
      path: documentPath('alert', alert.id),
      approvedHash,
    });
    await shares.replaceForDocument('saved_query', sharedQuery.id, [], 'bob');
    client.files.set(`${DEFAULT_BRANCH}:alerts/${alert.id}.yaml`, {
      contentText: alertToContent({ ...alert, name: 'Remote alert' }),
      sha: 'alert-revoked-sha',
    });

    await expect(service.pullDocument(principalAlice, 'alert', alert.id)).rejects.toMatchObject({
      status: 404,
      detail: { code: 'NOT_FOUND' },
    });
    expect((await alerts.getById(alert.id))?.name).toBe('Local alert');
    expect((await links.get('alert', alert.id))?.approvedHash).toBe(approvedHash);
    await db.close();
  });

  it('pullDocument assigns new notebook cell ids', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, notebooks, links } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const notebook = await notebooks.create('alice', {
      name: 'NB',
      cells: [{ id: 'c_local', kind: 'sql', source: 'SELECT 1' }],
    });
    const remoteContent = documentToContent('notebook', {
      ...notebook,
      cells: [{ id: 'c_ignored', kind: 'sql', source: 'SELECT 2' }],
    });
    await links.upsert('notebook', notebook.id, {
      path: documentPath('notebook', notebook.id),
      approvedHash: contentHash(documentToContent('notebook', notebook)),
    });
    client.files.set(`${DEFAULT_BRANCH}:notebooks/${notebook.id}.yaml`, {
      contentText: remoteContent,
      sha: 'nb-sha',
    });

    await service.pullDocument(principalAlice, 'notebook', notebook.id);
    const updated = await notebooks.get(accessorAlice, notebook.id);
    expect(updated?.cells[0]?.source).toBe('SELECT 2');
    expect(updated?.cells[0]?.id).not.toBe('c_local');
    expect(updated?.cells[0]?.id.startsWith('c_')).toBe(true);
    await db.close();
  });

  it('pullDocument assigns new dashboard widget ids and accepts missing savedQueryId refs', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, dashboards, links } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const dashboard = await dashboards.create('alice', {
      name: 'Board',
      widgets: [
        {
          id: 'w_local',
          kind: 'text',
          position: { col: 0, row: 0, sizeX: 4, sizeY: 2 },
          text: 'Local',
        },
      ],
    });
    const remoteContent = documentToContent('dashboard', {
      ...dashboard,
      widgets: [
        {
          id: 'w_ignored',
          kind: 'query',
          position: { col: 0, row: 0, sizeX: 6, sizeY: 4 },
          savedQueryId: 'sq_missing',
          viz: 'table',
        },
      ],
    });
    await links.upsert('dashboard', dashboard.id, {
      path: documentPath('dashboard', dashboard.id),
      approvedHash: contentHash(documentToContent('dashboard', dashboard)),
    });
    client.files.set(`${DEFAULT_BRANCH}:dashboards/${dashboard.id}.yaml`, {
      contentText: remoteContent,
      sha: 'dsh-sha',
    });

    await service.pullDocument(principalAlice, 'dashboard', dashboard.id);
    const updated = await dashboards.get(accessorAlice, dashboard.id);
    expect(updated?.widgets).toHaveLength(1);
    const widget = updated?.widgets[0];
    expect(widget?.kind).toBe('query');
    if (widget?.kind === 'query') {
      expect(widget.savedQueryId).toBe('sq_missing');
      expect(widget.id).not.toBe('w_local');
      expect(widget.id.startsWith('wgt_')).toBe(true);
    }
    await db.close();
  });

  it('syncAll pulls unchanged local when main advanced', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, links } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    const localContent = documentToContent('saved_query', saved);
    const localHash = contentHash(localContent);
    await links.upsert('saved_query', saved.id, {
      path: documentPath('saved_query', saved.id),
      approvedHash: localHash,
    });
    const remoteContent = savedQueryToContent({ ...saved, statement: 'SELECT 9' });
    client.files.set(`${DEFAULT_BRANCH}:saved-queries/${saved.id}.sql`, {
      contentText: remoteContent,
      sha: 'new-sha',
    });

    const summary = await service.syncAll();
    expect(summary.updated).toBe(1);
    const updated = await savedQueries.get(accessorAlice, saved.id);
    expect(updated?.statement).toBe('SELECT 9');
    const link = await links.get('saved_query', saved.id);
    expect(link?.approvedHash).toBe(contentHash(documentToContent('saved_query', updated!)));
    const second = await service.syncAll();
    expect(second.updated).toBe(0);
    expect(second.failed).toBe(0);
    await db.close();
  });

  it('syncAll skips locally modified documents', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, links } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    await links.upsert('saved_query', saved.id, {
      path: documentPath('saved_query', saved.id),
      approvedHash: contentHash(savedQueryToContent(saved)),
    });
    await savedQueries.update(accessorAlice, saved.id, {
      name: 'Q',
      description: '',
      statement: 'SELECT local-edit',
      isFavorite: false,
    });
    client.files.set(`${DEFAULT_BRANCH}:saved-queries/${saved.id}.sql`, {
      contentText: savedQueryToContent({ ...saved, statement: 'SELECT remote' }),
      sha: 'remote-sha',
    });

    const summary = await service.syncAll();
    expect(summary.skippedModified).toBe(1);
    expect(summary.updated).toBe(0);
    const doc = await savedQueries.get(accessorAlice, saved.id);
    expect(doc?.statement).toBe('SELECT local-edit');
    await db.close();
  });

  it('syncAll skips when owner is not connected and no sync token', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, links } = buildService(db, client);
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    await links.upsert('saved_query', saved.id, {
      path: documentPath('saved_query', saved.id),
      approvedHash: contentHash(savedQueryToContent(saved)),
    });
    client.files.set(`${DEFAULT_BRANCH}:saved-queries/${saved.id}.sql`, {
      contentText: savedQueryToContent({ ...saved, statement: 'SELECT 9' }),
      sha: 'remote-sha',
    });

    const summary = await service.syncAll();
    expect(summary.skippedNoToken).toBe(1);
    await db.close();
  });

  it('syncAll uses GITHUB_SYNC_TOKEN when owner is not connected', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, links } = buildService(db, client, () => Date.now(), {
      syncToken: 'server-token',
    });
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    const localHash = contentHash(savedQueryToContent(saved));
    await links.upsert('saved_query', saved.id, {
      path: documentPath('saved_query', saved.id),
      approvedHash: localHash,
    });
    client.files.set(`${DEFAULT_BRANCH}:saved-queries/${saved.id}.sql`, {
      contentText: savedQueryToContent({ ...saved, statement: 'SELECT synced' }),
      sha: 'sync-sha',
    });

    const summary = await service.syncAll();
    expect(summary.updated).toBe(1);
    await db.close();
  });

  it('syncAll counts parse failures and continues', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, notebooks, links } = buildService(db, client, () => Date.now(), {
      syncToken: 'server-token',
    });
    const notebook = await notebooks.create('alice', { name: 'NB' });
    await links.upsert('notebook', notebook.id, {
      path: documentPath('notebook', notebook.id),
      approvedHash: contentHash(documentToContent('notebook', notebook)),
    });
    client.files.set(`${DEFAULT_BRANCH}:notebooks/${notebook.id}.yaml`, {
      contentText: 'name: NB\ndescription: ""\ncontext: {}\nvariables: []\ncells: []\n',
      sha: 'bad-sha',
    });

    const summary = await service.syncAll();
    expect(summary.failed).toBe(1);
    await db.close();
  });

  it('syncAll does nothing when main is unchanged', async () => {
    const db = await openTestDatabase();
    const client = new FakeGithubClient();
    const { service, savedQueries, links } = buildService(db, client);
    await service.connect('alice', 'oauth-code');
    const saved = await savedQueries.create('alice', {
      name: 'Q',
      statement: 'SELECT 1',
    });
    const content = savedQueryToContent(saved);
    const hash = contentHash(content);
    await links.upsert('saved_query', saved.id, {
      path: documentPath('saved_query', saved.id),
      approvedHash: hash,
    });
    client.files.set(`${DEFAULT_BRANCH}:saved-queries/${saved.id}.sql`, {
      contentText: content,
      sha: 'same-sha',
    });

    const summary = await service.syncAll();
    expect(summary.updated).toBe(0);
    expect(summary.skippedModified).toBe(0);
    await db.close();
  });
});

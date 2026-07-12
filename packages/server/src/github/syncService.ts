/**
 * GitHub 連携の同期サービス。
 *
 * OAuth 接続、ドキュメント push、PR 作成、承認状態の判定を担う。
 * ルート層 (http/githubRoutes.ts) から呼ばれ、GitHub API と永続化層を束ねる。
 */
import type {
  DocumentGitType,
  GithubDocumentPullResponse,
  GithubDocumentPushResponse,
  GithubDocumentStatusResponse,
  GithubStatusResponse,
  Notebook,
  SavedQuery,
  Dashboard,
} from '@hubble/contracts';
import type { Principal } from '../auth/principal';
import type { GithubConfig } from '../config';
import { AppError } from '../errors';
import type { AuditLogger } from '../audit';
import { NotebookRepository } from '../store/notebooks';
import { DashboardRepository } from '../store/dashboards';
import { SavedQueryRepository } from '../store/savedQueries';
import { WorkflowRepository, type WorkflowRecord } from '../store/workflows';
import { AlertRepository, type AlertRecord } from '../store/alerts';
import { DocumentShareRepository } from '../store/documentShares';
import type { SqlDatabase } from '../db/sqlDatabase';
import { schedulePrincipalIdentity } from '../rbac/check';
import { resolveRoleForPrincipal } from '../rbac/resolve';
import type { LoadedRbac } from '../rbac/types';
import { branchNameFor, contentHash, documentPath, documentToContent } from './canonical';
import {
  parseAlertContent,
  parseDashboardContent,
  parseNotebookContent,
  parseSavedQueryContent,
  parseWorkflowContent,
  type ParsedNotebookContent,
} from './parse';
import { decryptToken, encryptToken, tokenNeedsRewrap } from './crypto';
import { GithubPullRequestExistsError, type GithubClient } from './client';
import {
  DocumentGitLinkRepository,
  GithubConnectionRepository,
  type DocumentGitLinkPatch,
  type DocumentGitLinkRecord,
} from './store';

interface ResolvedDocument {
  name: string;
  content: string;
  hash: string;
  path: string;
}

interface DecryptedConnection {
  login: string;
  accessToken: string;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}

interface PullRepositories {
  links: DocumentGitLinkRepository;
  savedQueries: SavedQueryRepository;
  notebooks: NotebookRepository;
  dashboards: DashboardRepository;
  workflows: WorkflowRepository;
  alerts: AlertRepository;
}

export interface GithubSyncServiceDeps {
  db: SqlDatabase;
  config: GithubConfig;
  client: GithubClient;
  connections: GithubConnectionRepository;
  links: DocumentGitLinkRepository;
  savedQueries: SavedQueryRepository;
  notebooks: NotebookRepository;
  dashboards: DashboardRepository;
  workflows: WorkflowRepository;
  alerts: AlertRepository;
  audit: AuditLogger;
  /** Alert owner の現在ロールを pull 適用時に解決するための RBAC getter。 */
  getRbac: () => LoadedRbac;
  now?: () => number;
}

/**
 * GitHub 連携のビジネスロジック。
 */
export class GithubSyncService {
  private readonly now: () => number;

  constructor(private readonly deps: GithubSyncServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** 機能全体の状態を返す。 */
  async getGlobalStatus(owner: string): Promise<GithubStatusResponse> {
    const { config, connections } = this.deps;
    const connection = await connections.get(owner);
    return {
      enabled: config.enabled,
      connected: connection !== undefined,
      login: connection?.githubLogin,
      repo: config.repo,
      governance: config.governance,
    };
  }

  /** OAuth code から接続を確立する。 */
  async connect(owner: string, code: string): Promise<void> {
    const token = await this.deps.client.exchangeCode(code);
    const user = await this.deps.client.getAuthenticatedUser(token.accessToken);
    const tokenKeys = this.tokenKeys();
    await this.deps.connections.upsert(owner, {
      githubLogin: user.login,
      accessTokenEnc: encryptToken(tokenKeys, token.accessToken),
      refreshTokenEnc: token.refreshToken ? encryptToken(tokenKeys, token.refreshToken) : null,
      tokenExpiresAt: token.expiresAt ?? null,
    });
    await this.deps.audit.record({
      actor: owner,
      action: 'github.connect',
      detail: { login: user.login },
    });
  }

  /** 接続を解除する。 */
  async disconnect(owner: string): Promise<void> {
    await this.deps.connections.delete(owner);
    await this.deps.audit.record({
      actor: owner,
      action: 'github.connect',
      detail: { action: 'disconnect' },
    });
  }

  /** ドキュメントの Git 承認状態を返す。 */
  async getStatus(
    principal: Principal,
    type: DocumentGitType,
    id: string,
  ): Promise<GithubDocumentStatusResponse> {
    this.assertEnabled();
    const resolved = await this.resolveDocument(principal, type, id, false);
    const link = await this.deps.links.get(type, id);
    const repo = this.deps.config.repo!;
    const defaultBranch = this.deps.config.defaultBranch;
    const htmlUrl = `https://github.com/${repo}/blob/${defaultBranch}/${resolved.path}`;
    const base: GithubDocumentStatusResponse = {
      status: 'unlinked',
      path: resolved.path,
      repo,
      htmlUrl,
    };

    if (!link) {
      const connection = await this.deps.connections.get(principal.user);
      return { ...base, connected: connection !== undefined };
    }

    let approvedHash = link.approvedHash;
    let approvedCommit = link.approvedCommit;
    let stale = false;
    const connection = await this.deps.connections.get(principal.user);
    const connected = connection !== undefined;

    if (connected) {
      const verification = await this.verifyApprovedHash(principal.user, link, resolved.path);
      approvedHash = verification.approvedHash;
      approvedCommit = verification.approvedCommit;
      stale = verification.stale;
    }

    const status = this.resolveStatus(resolved.hash, link, approvedHash);
    return {
      status,
      path: link.path,
      branch: link.branch ?? undefined,
      prNumber: link.prNumber ?? undefined,
      prUrl: link.prUrl ?? undefined,
      approvedCommit: approvedCommit ?? undefined,
      repo,
      htmlUrl,
      connected,
      ...(stale ? { stale: true } : {}),
    };
  }

  /** ドキュメントを feature ブランチへ push する。 */
  async push(
    principal: Principal,
    type: DocumentGitType,
    id: string,
    options: { message?: string } = {},
  ): Promise<GithubDocumentPushResponse> {
    this.assertEnabled();
    const resolved = await this.resolveDocument(principal, type, id, true);
    const { accessToken } = await this.requireConnection(principal.user);
    const repo = this.deps.config.repo!;
    const defaultBranch = this.deps.config.defaultBranch;
    const branch = branchNameFor(principal.user, type, id);
    if (branch === defaultBranch) {
      throw AppError.internal('Refusing to push to default branch');
    }

    const headSha = await this.deps.client.getBranchHeadSha(accessToken, repo, defaultBranch);
    if (!headSha) {
      throw new AppError(502, {
        code: 'GITHUB_ERROR',
        message: `Default branch ${defaultBranch} not found`,
      });
    }

    const existingBranchSha = await this.deps.client.getBranchHeadSha(accessToken, repo, branch);
    if (!existingBranchSha) {
      await this.deps.client.createBranch(accessToken, repo, branch, headSha);
    }

    const existingFile = await this.deps.client.getFile(accessToken, repo, resolved.path, branch);
    const message = options.message ?? `Update ${resolved.path} via Hubble`;
    const putResult = await this.deps.client.putFile(accessToken, repo, {
      path: resolved.path,
      branch,
      contentText: resolved.content,
      message,
      sha: existingFile?.sha,
    });

    await this.deps.links.upsert(type, id, {
      path: resolved.path,
      branch,
      lastPushedCommit: putResult.commitSha,
      lastPushedHash: resolved.hash,
    });

    await this.deps.audit.record({
      actor: principal.user,
      action: 'github.push',
      target: `${type}:${id}`,
      detail: {
        repo,
        branch,
        path: resolved.path,
        commitSha: putResult.commitSha,
      },
    });

    return {
      branch,
      path: resolved.path,
      commitSha: putResult.commitSha,
      compareUrl: `https://github.com/${repo}/compare/${defaultBranch}...${branch}`,
    };
  }

  /** feature ブランチから PR を作成する。 */
  async createPullRequest(
    principal: Principal,
    type: DocumentGitType,
    id: string,
    options: { title?: string; body?: string } = {},
  ): Promise<{ prNumber: number; prUrl: string }> {
    this.assertEnabled();
    const resolved = await this.resolveDocument(principal, type, id, true);
    const { accessToken } = await this.requireConnection(principal.user);
    const link = await this.deps.links.get(type, id);
    if (!link?.branch) {
      throw AppError.badRequest('Push the document to GitHub before creating a pull request');
    }

    const repo = this.deps.config.repo!;
    const defaultBranch = this.deps.config.defaultBranch;
    const [repoOwner] = repo.split('/');
    const title = options.title ?? `Update ${resolved.path}`;
    const body =
      options.body ?? `Updated from Hubble.\n\nDocument: ${resolved.name}\nPath: ${resolved.path}`;

    let prNumber: number;
    let prUrl: string;
    try {
      const created = await this.deps.client.createPullRequest(accessToken, repo, {
        head: link.branch,
        base: defaultBranch,
        title,
        body,
      });
      prNumber = created.number;
      prUrl = created.url;
    } catch (err) {
      if (!(err instanceof GithubPullRequestExistsError)) throw err;
      const head = `${repoOwner}:${link.branch}`;
      const existing = await this.deps.client.listPullRequests(accessToken, repo, head);
      const open = existing.find((item) => item.state === 'open');
      if (!open) {
        throw err;
      }
      prNumber = open.number;
      prUrl = open.url;
    }

    await this.deps.links.upsert(type, id, {
      path: resolved.path,
      prNumber,
      prUrl,
    });

    await this.deps.audit.record({
      actor: principal.user,
      action: 'github.pr.create',
      target: `${type}:${id}`,
      detail: {
        repo,
        branch: link.branch,
        path: resolved.path,
        prNumber,
        prUrl,
      },
    });

    return { prNumber, prUrl };
  }

  /**
   * main の承認済み内容をローカルへ強制取り込みする (手動)。
   * owner の GitHub 接続トークンで main を読む。
   */
  async pullDocument(
    principal: Principal,
    type: DocumentGitType,
    id: string,
  ): Promise<GithubDocumentPullResponse> {
    this.assertEnabled();
    await this.resolveDocument(principal, type, id, true);
    const link = await this.deps.links.get(type, id);
    if (!link) {
      throw AppError.badRequest('Document is not linked to GitHub', 'GITHUB_NOT_LINKED');
    }
    const { accessToken } = await this.requireConnection(principal.user);
    return this.pullFromMain({
      type,
      id,
      link,
      accessToken,
      actor: principal.user,
      trigger: 'manual',
    });
  }

  /**
   * 全リンク済みドキュメントを main と同期する (定時バッチ)。
   *
   * ローカルが最後の承認内容から変更されていないリンクのみ fast-forward 相当で更新する。
   * 更新は各ドキュメント owner の名義で行うが、実行主体はサーバーである。
   */
  async syncAll(): Promise<{
    updated: number;
    skippedModified: number;
    skippedNoToken: number;
    failed: number;
  }> {
    this.assertEnabled();
    const links = await this.deps.links.listAll();
    let updated = 0;
    let skippedModified = 0;
    let skippedNoToken = 0;
    let failed = 0;

    for (const link of links) {
      try {
        const outcome = await this.syncOneLink(link);
        switch (outcome) {
          case 'updated':
            updated += 1;
            break;
          case 'skippedModified':
            skippedModified += 1;
            break;
          case 'skippedNoToken':
            skippedNoToken += 1;
            break;
          case 'failed':
            failed += 1;
            break;
          case 'unchanged':
          case 'skippedMissingDoc':
          case 'skippedUnapproved':
          case 'skippedMissingFile':
            break;
        }
      } catch (err) {
        failed += 1;
        console.warn(
          `github sync: unexpected error for ${link.documentType}:${link.documentId}`,
          err,
        );
      }
    }

    console.log(
      `github sync: completed updated=${updated} skippedModified=${skippedModified} skippedNoToken=${skippedNoToken} failed=${failed}`,
    );
    return { updated, skippedModified, skippedNoToken, failed };
  }

  private async pullFromMain(params: {
    type: DocumentGitType;
    id: string;
    link: DocumentGitLinkRecord;
    accessToken: string;
    actor: string;
    trigger: 'manual' | 'scheduled';
  }): Promise<GithubDocumentPullResponse> {
    const { type, id, link, accessToken, actor, trigger } = params;
    const repo = this.deps.config.repo!;
    const defaultBranch = this.deps.config.defaultBranch;
    const file = await this.deps.client.getFile(accessToken, repo, link.path, defaultBranch);
    if (!file) {
      throw new AppError(404, {
        code: 'GITHUB_FILE_MISSING',
        message: `File ${link.path} not found on ${defaultBranch}`,
      });
    }

    const nowIso = new Date(this.now()).toISOString();
    await this.applyPulledContent(type, id, actor, file.contentText, {
      path: link.path,
      approvedCommit: file.sha,
      lastPushedCommit: file.sha,
      checkedAt: nowIso,
    });

    await this.deps.audit.record({
      actor,
      action: 'github.pull',
      target: `${type}:${id}`,
      detail: {
        repo,
        path: link.path,
        commit: file.sha,
        trigger,
      },
    });

    return { pulled: true, commit: file.sha, status: 'approved' };
  }

  private async syncOneLink(
    link: DocumentGitLinkRecord,
  ): Promise<
    | 'updated'
    | 'skippedModified'
    | 'skippedNoToken'
    | 'failed'
    | 'unchanged'
    | 'skippedMissingDoc'
    | 'skippedUnapproved'
    | 'skippedMissingFile'
  > {
    const { documentType: type, documentId: id } = link;
    const doc = await this.loadDocumentUnscoped(type, id);
    if (!doc) {
      return 'skippedMissingDoc';
    }

    const currentHash = contentHash(documentToContent(type, doc));
    if (!link.approvedHash || currentHash !== link.approvedHash) {
      return link.approvedHash ? 'skippedModified' : 'skippedUnapproved';
    }

    const owner = await this.getDocumentOwner(type, id);
    if (!owner) {
      return 'skippedMissingDoc';
    }

    const accessToken = await this.resolveReadToken(owner);
    if (!accessToken) {
      console.warn(`github sync: skipping ${type}:${id} (no read token for owner ${owner})`);
      return 'skippedNoToken';
    }

    const repo = this.deps.config.repo!;
    const defaultBranch = this.deps.config.defaultBranch;
    const file = await this.deps.client.getFile(accessToken, repo, link.path, defaultBranch);
    const nowIso = new Date(this.now()).toISOString();

    if (!file) {
      await this.deps.links.upsert(type, id, {
        path: link.path,
        approvedHash: null,
        approvedCommit: null,
        checkedAt: nowIso,
      });
      return 'skippedMissingFile';
    }

    const remoteHash = contentHash(file.contentText);
    if (file.sha === link.approvedCommit || remoteHash === link.approvedHash) {
      return 'unchanged';
    }

    try {
      await this.applyPulledContent(type, id, owner, file.contentText, {
        path: link.path,
        approvedCommit: file.sha,
        lastPushedCommit: file.sha,
        checkedAt: nowIso,
      });
      await this.deps.audit.record({
        actor: owner,
        action: 'github.pull',
        target: `${type}:${id}`,
        detail: {
          repo,
          path: link.path,
          commit: file.sha,
          trigger: 'scheduled',
        },
      });
      return 'updated';
    } catch (err) {
      console.warn(`github sync: failed to pull ${type}:${id}`, err);
      return 'failed';
    }
  }

  private async resolveReadToken(owner: string): Promise<string | undefined> {
    if (this.deps.config.syncToken) {
      return this.deps.config.syncToken;
    }
    try {
      const connection = await this.getConnection(owner);
      return connection?.accessToken;
    } catch (err) {
      // トークン期限切れ + refresh 失敗 (GITHUB_TOKEN_INVALID) は定時同期の文脈では
      // 「読み取りトークンが無い」と同じ扱いとし、failed でなく skippedNoToken に計上する。
      console.warn(`github sync: failed to resolve read token for owner ${owner}`, err);
      return undefined;
    }
  }

  private async getDocumentOwner(type: DocumentGitType, id: string): Promise<string | undefined> {
    switch (type) {
      case 'saved_query':
        return this.deps.savedQueries.getOwner(id);
      case 'notebook':
        return this.deps.notebooks.getOwner(id);
      case 'workflow':
        return (await this.deps.workflows.getById(id))?.owner;
      case 'alert':
        return (await this.deps.alerts.getById(id))?.owner;
      case 'dashboard':
        return this.deps.dashboards.getOwner(id);
    }
  }

  private async loadDocumentUnscoped(
    type: DocumentGitType,
    id: string,
    repositories: PullRepositories = this.deps,
  ): Promise<SavedQuery | Notebook | WorkflowRecord | AlertRecord | Dashboard | undefined> {
    switch (type) {
      case 'saved_query':
        return repositories.savedQueries.getByIdUnscoped(id);
      case 'notebook':
        return repositories.notebooks.getByIdUnscoped(id);
      case 'workflow':
        return repositories.workflows.getById(id);
      case 'alert':
        return repositories.alerts.getById(id);
      case 'dashboard':
        return repositories.dashboards.getByIdUnscoped(id);
    }
  }

  private repositoriesFor(db: SqlDatabase): PullRepositories {
    const shares = new DocumentShareRepository(db);
    return {
      links: new DocumentGitLinkRepository(db),
      savedQueries: new SavedQueryRepository(db, shares),
      notebooks: new NotebookRepository(db, shares),
      dashboards: new DashboardRepository(db, shares),
      workflows: new WorkflowRepository(db),
      alerts: new AlertRepository(db),
    };
  }

  private async applyPulledContent(
    type: DocumentGitType,
    id: string,
    owner: string,
    contentText: string,
    linkPatch: DocumentGitLinkPatch & { path: string },
  ): Promise<string> {
    return this.deps.db.transaction(async (tx) => {
      const repositories = this.repositoriesFor(tx);
      await this.applyParsedContent(type, id, owner, contentText, repositories);
      const applied = await this.loadDocumentUnscoped(type, id, repositories);
      if (!applied) throw AppError.notFound(`${type} ${id} not found after pull`);
      const canonicalHash = contentHash(documentToContent(type, applied));
      await repositories.links.upsert(type, id, {
        ...linkPatch,
        approvedHash: canonicalHash,
        lastPushedHash: canonicalHash,
      });
      return canonicalHash;
    });
  }

  private async applyParsedContent(
    type: DocumentGitType,
    id: string,
    owner: string,
    contentText: string,
    repositories: PullRepositories = this.deps,
  ): Promise<void> {
    const accessor = { user: owner, groups: [] as string[], role: 'admin' };
    switch (type) {
      case 'saved_query': {
        const parsed = parseSavedQueryContent(contentText);
        const existing = await repositories.savedQueries.getByIdUnscoped(id);
        if (!existing) {
          throw AppError.notFound('Saved query not found');
        }
        await repositories.savedQueries.update(accessor, id, {
          name: parsed.name,
          description: parsed.description,
          statement: parsed.statement,
          catalog: parsed.catalog,
          schema: parsed.schema,
          datasourceId: parsed.datasourceId,
          isFavorite: existing.isFavorite,
        });
        break;
      }
      case 'notebook': {
        const parsed = parseNotebookContent(contentText);
        await this.applyNotebookUpdate(accessor, id, parsed, repositories.notebooks);
        break;
      }
      case 'workflow': {
        const parsed = parseWorkflowContent(contentText);
        const existing = await repositories.workflows.getById(id);
        if (!existing) {
          throw AppError.notFound('Workflow not found');
        }
        await repositories.workflows.update(owner, id, {
          name: parsed.name,
          description: parsed.description,
          stages: parsed.stages,
          datasourceId: parsed.datasourceId,
          cron: parsed.cron,
          retry: parsed.retry,
          enabled: existing.enabled,
        });
        break;
      }
      case 'alert': {
        const parsed = parseAlertContent(contentText);
        const existing = await repositories.alerts.getById(id);
        if (!existing) {
          throw AppError.notFound('Alert not found');
        }
        const identity = schedulePrincipalIdentity(existing.owner, existing.principalSnapshot);
        const role = resolveRoleForPrincipal(this.deps.getRbac(), identity);
        const savedQuery = await repositories.savedQueries.get(
          {
            user: existing.owner,
            groups: identity.groups ?? [],
            role: role.name,
          },
          parsed.savedQueryId,
        );
        if (!savedQuery) {
          throw AppError.notFound('Saved query not found');
        }
        await repositories.alerts.update(owner, id, {
          name: parsed.name,
          savedQueryId: parsed.savedQueryId,
          columnName: parsed.columnName,
          op: parsed.op,
          value: parsed.value,
          selector: parsed.selector,
          rearm: parsed.rearm,
          muted: parsed.muted,
          cron: parsed.cron,
          notifications: {
            ...parsed.notifications,
            ...(existing.notifications.webhookUrl !== undefined
              ? { webhookUrl: existing.notifications.webhookUrl }
              : {}),
          },
        });
        break;
      }
      case 'dashboard': {
        const parsed = parseDashboardContent(contentText);
        const existing = await repositories.dashboards.getByIdUnscoped(id);
        if (!existing) {
          throw AppError.notFound('Dashboard not found');
        }
        await repositories.dashboards.update(accessor, id, {
          name: parsed.name,
          description: parsed.description,
          widgets: parsed.widgets,
        });
        break;
      }
    }
  }

  private async applyNotebookUpdate(
    accessor: { user: string; groups: string[]; role: string },
    id: string,
    parsed: ParsedNotebookContent,
    notebooks = this.deps.notebooks,
  ): Promise<void> {
    const existing = await notebooks.get(accessor, id);
    if (!existing) {
      throw AppError.notFound('Notebook not found');
    }
    const result = await notebooks.update(accessor, id, {
      revision: existing.revision,
      name: parsed.name,
      description: parsed.description,
      cells: parsed.cells,
      variables: parsed.variables,
      context: parsed.context,
    });
    if (result === 'forbidden') {
      throw AppError.forbidden('Only the document owner can update this notebook');
    }
    if (result === 'conflict') {
      throw new AppError(409, {
        code: 'NOTEBOOK_REVISION_CONFLICT',
        message: 'Notebook was updated while applying GitHub content',
      });
    }
    if (!result) {
      throw AppError.notFound('Notebook not found');
    }
  }

  private assertEnabled(): void {
    if (!this.deps.config.enabled) {
      throw new AppError(404, {
        code: 'GITHUB_DISABLED',
        message: 'GitHub integration is disabled',
      });
    }
  }

  private async requireConnection(owner: string): Promise<DecryptedConnection> {
    const connection = await this.getConnection(owner);
    if (!connection) {
      throw new AppError(401, {
        code: 'GITHUB_NOT_CONNECTED',
        message: 'Connect your GitHub account before using this feature',
      });
    }
    return connection;
  }

  /** 復号済みトークンを返す。期限切れなら refresh する。 */
  async getConnection(owner: string): Promise<DecryptedConnection | undefined> {
    const row = await this.deps.connections.get(owner);
    if (!row) return undefined;

    const tokenKeys = this.tokenKeys();
    let accessToken = decryptToken(tokenKeys, row.accessTokenEnc);
    let refreshToken = row.refreshTokenEnc ? decryptToken(tokenKeys, row.refreshTokenEnc) : null;
    let tokenExpiresAt = row.tokenExpiresAt;
    let shouldPersist =
      tokenNeedsRewrap(tokenKeys, row.accessTokenEnc) ||
      (row.refreshTokenEnc !== null && tokenNeedsRewrap(tokenKeys, row.refreshTokenEnc));

    if (this.isExpired(tokenExpiresAt) && refreshToken) {
      try {
        const refreshed = await this.deps.client.refreshAccessToken(refreshToken);
        accessToken = refreshed.accessToken;
        refreshToken = refreshed.refreshToken ?? refreshToken;
        tokenExpiresAt = refreshed.expiresAt ?? null;
        shouldPersist = true;
      } catch (err) {
        if (err instanceof AppError && err.detail.code === 'GITHUB_TOKEN_INVALID') {
          throw err;
        }
        throw new AppError(401, {
          code: 'GITHUB_TOKEN_INVALID',
          message: 'GitHub token is invalid or expired',
        });
      }
    }

    if (shouldPersist) {
      await this.deps.connections.upsert(owner, {
        githubLogin: row.githubLogin,
        accessTokenEnc: encryptToken(tokenKeys, accessToken),
        refreshTokenEnc: refreshToken ? encryptToken(tokenKeys, refreshToken) : null,
        tokenExpiresAt,
      });
    }

    return {
      login: row.githubLogin,
      accessToken,
      refreshToken,
      tokenExpiresAt,
    };
  }

  private tokenKeys() {
    const tokenKeys = this.deps.config.tokenEncryptionKeys;
    if (!tokenKeys) throw new Error('GitHub token encryption keyring is not configured');
    return tokenKeys;
  }

  private isExpired(tokenExpiresAt: string | null | undefined): boolean {
    if (!tokenExpiresAt) return false;
    return Date.parse(tokenExpiresAt) <= this.now();
  }

  private async resolveDocument(
    principal: Principal,
    type: DocumentGitType,
    id: string,
    requireOwner: boolean,
  ): Promise<ResolvedDocument> {
    const accessor = {
      user: principal.user,
      groups: principal.groups ?? [],
      role: principal.role.name,
    };

    let name: string;
    let content: string;

    switch (type) {
      case 'saved_query': {
        const doc = await this.deps.savedQueries.get(accessor, id);
        if (!doc) throw AppError.notFound('Saved query not found');
        if (requireOwner && doc.myPermission !== 'owner') {
          throw AppError.forbidden('Only the document owner can push to GitHub');
        }
        name = doc.name;
        content = documentToContent(type, doc);
        break;
      }
      case 'notebook': {
        const doc = await this.deps.notebooks.get(accessor, id);
        if (!doc) throw AppError.notFound('Notebook not found');
        if (requireOwner && doc.myPermission !== 'owner') {
          throw AppError.forbidden('Only the document owner can push to GitHub');
        }
        name = doc.name;
        content = documentToContent(type, doc);
        break;
      }
      case 'workflow': {
        const doc = await this.deps.workflows.get(principal.user, id);
        if (!doc) throw AppError.notFound('Workflow not found');
        name = doc.name;
        content = documentToContent(type, doc);
        break;
      }
      case 'alert': {
        const doc = await this.deps.alerts.get(principal.user, id);
        if (!doc) throw AppError.notFound('Alert not found');
        name = doc.name;
        content = documentToContent(type, doc);
        break;
      }
      case 'dashboard': {
        const doc = await this.deps.dashboards.get(accessor, id);
        if (!doc) throw AppError.notFound('Dashboard not found');
        if (requireOwner && doc.myPermission !== 'owner') {
          throw AppError.forbidden('Only the document owner can push to GitHub');
        }
        name = doc.name;
        content = documentToContent(type, doc);
        break;
      }
    }

    const path = documentPath(type, id);
    return { name, content, hash: contentHash(content), path };
  }

  private resolveStatus(
    currentHash: string,
    link: DocumentGitLinkRecord,
    approvedHash: string | null,
  ): GithubDocumentStatusResponse['status'] {
    if (approvedHash && currentHash === approvedHash) {
      return 'approved';
    }
    if (
      link.lastPushedHash &&
      currentHash === link.lastPushedHash &&
      currentHash !== approvedHash
    ) {
      return 'in_review';
    }
    return 'modified';
  }

  private async verifyApprovedHash(
    owner: string,
    link: DocumentGitLinkRecord,
    path: string,
  ): Promise<{ approvedHash: string | null; approvedCommit: string | null; stale: boolean }> {
    const ttlMs = this.deps.config.statusTtlSeconds * 1000;
    const checkedAt = link.checkedAt ? Date.parse(link.checkedAt) : 0;
    if (link.checkedAt && this.now() - checkedAt < ttlMs) {
      return {
        approvedHash: link.approvedHash,
        approvedCommit: link.approvedCommit,
        stale: false,
      };
    }

    try {
      const connection = await this.requireConnection(owner);
      const repo = this.deps.config.repo!;
      const defaultBranch = this.deps.config.defaultBranch;
      const file = await this.deps.client.getFile(
        connection.accessToken,
        repo,
        path,
        defaultBranch,
      );
      const nowIso = new Date(this.now()).toISOString();
      if (!file) {
        await this.deps.links.upsert(link.documentType, link.documentId, {
          path: link.path,
          approvedHash: null,
          approvedCommit: null,
          checkedAt: nowIso,
        });
        return { approvedHash: null, approvedCommit: null, stale: false };
      }
      const approvedHash = contentHash(file.contentText);
      await this.deps.links.upsert(link.documentType, link.documentId, {
        path: link.path,
        approvedHash,
        approvedCommit: file.sha,
        checkedAt: nowIso,
      });
      return { approvedHash, approvedCommit: file.sha, stale: false };
    } catch {
      return {
        approvedHash: link.approvedHash,
        approvedCommit: link.approvedCommit,
        stale: true,
      };
    }
  }
}

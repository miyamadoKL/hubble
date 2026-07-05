/**
 * GitHub 連携の永続化層。
 *
 * OAuth 接続情報 (github_connections) とドキュメントの Git リンク
 * (document_git_links) を SqlDatabase 上で CRUD する。
 */
import type { DocumentGitType } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';

export interface GithubConnectionRecord {
  owner: string;
  githubLogin: string;
  accessTokenEnc: string;
  refreshTokenEnc: string | null;
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GithubConnectionUpsert {
  githubLogin: string;
  accessTokenEnc: string;
  refreshTokenEnc?: string | null;
  tokenExpiresAt?: string | null;
}

export interface DocumentGitLinkRecord {
  documentType: DocumentGitType;
  documentId: string;
  path: string;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  lastPushedCommit: string | null;
  lastPushedHash: string | null;
  approvedHash: string | null;
  approvedCommit: string | null;
  checkedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DocumentGitLinkPatch = Partial<
  Pick<
    DocumentGitLinkRecord,
    | 'path'
    | 'branch'
    | 'prNumber'
    | 'prUrl'
    | 'lastPushedCommit'
    | 'lastPushedHash'
    | 'approvedHash'
    | 'approvedCommit'
    | 'checkedAt'
  >
>;

interface GithubConnectionRow {
  owner: string;
  github_login: string;
  access_token_enc: string;
  refresh_token_enc: string | null;
  token_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DocumentGitLinkRow {
  document_type: string;
  document_id: string;
  path: string;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  last_pushed_commit: string | null;
  last_pushed_hash: string | null;
  approved_hash: string | null;
  approved_commit: string | null;
  checked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** github_connections テーブルへの CRUD。 */
export class GithubConnectionRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** owner に紐づく接続情報を取得する。 */
  async get(owner: string): Promise<GithubConnectionRecord | undefined> {
    const rows = await this.db.query<GithubConnectionRow>(
      'SELECT * FROM github_connections WHERE owner = ?',
      [owner],
    );
    return rows[0] ? rowToConnection(rows[0]) : undefined;
  }

  /** 接続情報を upsert する。 */
  async upsert(owner: string, input: GithubConnectionUpsert): Promise<GithubConnectionRecord> {
    const nowIso = new Date().toISOString();
    const existing = await this.get(owner);
    if (existing) {
      await this.db.run(
        `UPDATE github_connections
         SET github_login = ?, access_token_enc = ?, refresh_token_enc = ?,
             token_expires_at = ?, updated_at = ?
         WHERE owner = ?`,
        [
          input.githubLogin,
          input.accessTokenEnc,
          input.refreshTokenEnc ?? null,
          input.tokenExpiresAt ?? null,
          nowIso,
          owner,
        ],
      );
      return {
        ...existing,
        githubLogin: input.githubLogin,
        accessTokenEnc: input.accessTokenEnc,
        refreshTokenEnc: input.refreshTokenEnc ?? null,
        tokenExpiresAt: input.tokenExpiresAt ?? null,
        updatedAt: nowIso,
      };
    }
    await this.db.run(
      `INSERT INTO github_connections
         (owner, github_login, access_token_enc, refresh_token_enc, token_expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        owner,
        input.githubLogin,
        input.accessTokenEnc,
        input.refreshTokenEnc ?? null,
        input.tokenExpiresAt ?? null,
        nowIso,
        nowIso,
      ],
    );
    return {
      owner,
      githubLogin: input.githubLogin,
      accessTokenEnc: input.accessTokenEnc,
      refreshTokenEnc: input.refreshTokenEnc ?? null,
      tokenExpiresAt: input.tokenExpiresAt ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
  }

  /** 接続情報を削除する。 */
  async delete(owner: string): Promise<void> {
    await this.db.run('DELETE FROM github_connections WHERE owner = ?', [owner]);
  }
}

/** document_git_links テーブルへの CRUD。 */
export class DocumentGitLinkRepository {
  constructor(private readonly db: SqlDatabase) {}

  /** ドキュメントの Git リンクを取得する。 */
  async get(type: DocumentGitType, id: string): Promise<DocumentGitLinkRecord | undefined> {
    const rows = await this.db.query<DocumentGitLinkRow>(
      'SELECT * FROM document_git_links WHERE document_type = ? AND document_id = ?',
      [type, id],
    );
    return rows[0] ? rowToLink(rows[0]) : undefined;
  }

  /** ドキュメントの Git リンクを upsert する。 */
  async upsert(
    type: DocumentGitType,
    id: string,
    patch: DocumentGitLinkPatch & { path?: string },
  ): Promise<DocumentGitLinkRecord> {
    const nowIso = new Date().toISOString();
    const existing = await this.get(type, id);
    if (existing) {
      const next = mergeLink(existing, patch, nowIso);
      await this.db.run(
        `UPDATE document_git_links
         SET path = ?, branch = ?, pr_number = ?, pr_url = ?,
             last_pushed_commit = ?, last_pushed_hash = ?,
             approved_hash = ?, approved_commit = ?, checked_at = ?, updated_at = ?
         WHERE document_type = ? AND document_id = ?`,
        linkParams(next, type, id),
      );
      return next;
    }
    const path = patch.path;
    if (!path) {
      throw new Error('path is required when creating a document git link');
    }
    const created: DocumentGitLinkRecord = {
      documentType: type,
      documentId: id,
      path,
      branch: patch.branch ?? null,
      prNumber: patch.prNumber ?? null,
      prUrl: patch.prUrl ?? null,
      lastPushedCommit: patch.lastPushedCommit ?? null,
      lastPushedHash: patch.lastPushedHash ?? null,
      approvedHash: patch.approvedHash ?? null,
      approvedCommit: patch.approvedCommit ?? null,
      checkedAt: patch.checkedAt ?? null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    await this.db.run(
      `INSERT INTO document_git_links
         (document_type, document_id, path, branch, pr_number, pr_url,
          last_pushed_commit, last_pushed_hash, approved_hash, approved_commit, checked_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        type,
        id,
        created.path,
        created.branch,
        created.prNumber,
        created.prUrl,
        created.lastPushedCommit,
        created.lastPushedHash,
        created.approvedHash,
        created.approvedCommit,
        created.checkedAt,
        created.createdAt,
        created.updatedAt,
      ],
    );
    return created;
  }

  /** ドキュメントの Git リンクを削除する。 */
  async delete(type: DocumentGitType, id: string): Promise<void> {
    await this.db.run(
      'DELETE FROM document_git_links WHERE document_type = ? AND document_id = ?',
      [type, id],
    );
  }

  /** approved_hash が設定されている全 Git リンクを返す (ガバナンス用)。 */
  async listApproved(): Promise<DocumentGitLinkRecord[]> {
    const rows = await this.db.query<DocumentGitLinkRow>(
      'SELECT * FROM document_git_links WHERE approved_hash IS NOT NULL',
    );
    return rows.map(rowToLink);
  }

  /** 全 Git リンクを返す (定時同期用)。 */
  async listAll(): Promise<DocumentGitLinkRecord[]> {
    const rows = await this.db.query<DocumentGitLinkRow>(
      'SELECT * FROM document_git_links ORDER BY document_type, document_id',
    );
    return rows.map(rowToLink);
  }
}

function rowToConnection(row: GithubConnectionRow): GithubConnectionRecord {
  return {
    owner: row.owner,
    githubLogin: row.github_login,
    accessTokenEnc: row.access_token_enc,
    refreshTokenEnc: row.refresh_token_enc,
    tokenExpiresAt: row.token_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToLink(row: DocumentGitLinkRow): DocumentGitLinkRecord {
  return {
    documentType: row.document_type as DocumentGitType,
    documentId: row.document_id,
    path: row.path,
    branch: row.branch,
    prNumber: row.pr_number,
    prUrl: row.pr_url,
    lastPushedCommit: row.last_pushed_commit,
    lastPushedHash: row.last_pushed_hash,
    approvedHash: row.approved_hash,
    approvedCommit: row.approved_commit,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mergeLink(
  existing: DocumentGitLinkRecord,
  patch: DocumentGitLinkPatch & { path?: string },
  nowIso: string,
): DocumentGitLinkRecord {
  return {
    ...existing,
    path: patch.path ?? existing.path,
    branch: patch.branch !== undefined ? patch.branch : existing.branch,
    prNumber: patch.prNumber !== undefined ? patch.prNumber : existing.prNumber,
    prUrl: patch.prUrl !== undefined ? patch.prUrl : existing.prUrl,
    lastPushedCommit:
      patch.lastPushedCommit !== undefined ? patch.lastPushedCommit : existing.lastPushedCommit,
    lastPushedHash:
      patch.lastPushedHash !== undefined ? patch.lastPushedHash : existing.lastPushedHash,
    approvedHash: patch.approvedHash !== undefined ? patch.approvedHash : existing.approvedHash,
    approvedCommit:
      patch.approvedCommit !== undefined ? patch.approvedCommit : existing.approvedCommit,
    checkedAt: patch.checkedAt !== undefined ? patch.checkedAt : existing.checkedAt,
    updatedAt: nowIso,
  };
}

function linkParams(link: DocumentGitLinkRecord, type: DocumentGitType, id: string): SqlParam[] {
  return [
    link.path,
    link.branch,
    link.prNumber,
    link.prUrl,
    link.lastPushedCommit,
    link.lastPushedHash,
    link.approvedHash,
    link.approvedCommit,
    link.checkedAt,
    link.updatedAt,
    type,
    id,
  ];
}

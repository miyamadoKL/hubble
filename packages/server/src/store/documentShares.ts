/**
 * 保存済みクエリとノートブックの共有エントリ (`document_shares` テーブル) を
 * 永続化するリポジトリ。共有先 (user / group / role) ごとの permission 解決、
 * ドキュメント単位の全置換、削除時の後始末を提供する。
 */
import type { DocumentShare, SharePermission } from '@hubble/contracts';
import { documentShareSchema } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { newId } from '../util/id';

/** 共有対象のドキュメント種別。 */
export type DocumentType = 'saved_query' | 'notebook' | 'dashboard';

/** permission 解決時に参照する principal 属性。 */
export interface ShareAccessor {
  user: string;
  groups: readonly string[];
  role: string;
}

/** リポジトリ操作で権限不足を表すセンチネル。 */
export type StoreForbidden = 'forbidden';

interface DocumentShareRow {
  id: string;
  document_type: string;
  document_id: string;
  subject_type: string;
  subject_value: string;
  permission: string;
  created_by: string;
  created_at: string;
}

/**
 * `document_shares` テーブルへの CRUD と accessor 向け permission 解決を提供する。
 */
export class DocumentShareRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * 指定ドキュメントに設定されている共有エントリ一覧を返す。
   * @param type - ドキュメント種別。
   * @param documentId - ドキュメント id。
   */
  async listForDocument(type: DocumentType, documentId: string): Promise<DocumentShare[]> {
    const rows = await this.db.query<DocumentShareRow>(
      `SELECT subject_type, subject_value, permission, created_at
       FROM document_shares
       WHERE document_type = ? AND document_id = ?
       ORDER BY created_at ASC, id ASC`,
      [type, documentId],
    );
    return rows.map(rowToDocumentShare);
  }

  /**
   * 指定ドキュメントの共有を全削除してから新しい一覧を挿入する (全置換)。
   * @param type - ドキュメント種別。
   * @param documentId - ドキュメント id。
   * @param shares - 新しい共有一覧。
   * @param createdBy - 操作者 (owner) の user id。
   */
  async replaceForDocument(
    type: DocumentType,
    documentId: string,
    shares: ReadonlyArray<Pick<DocumentShare, 'subjectType' | 'subjectValue' | 'permission'>>,
    createdBy: string,
  ): Promise<DocumentShare[]> {
    const nowIso = new Date().toISOString();
    return this.db.transaction(async (tx) => {
      await tx.run('DELETE FROM document_shares WHERE document_type = ? AND document_id = ?', [
        type,
        documentId,
      ]);
      for (const share of shares) {
        await tx.run(
          `INSERT INTO document_shares
             (id, document_type, document_id, subject_type, subject_value, permission, created_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId('shr_'),
            type,
            documentId,
            share.subjectType,
            share.subjectValue,
            share.permission,
            createdBy,
            nowIso,
          ],
        );
      }
      const repo = new DocumentShareRepository(tx);
      return repo.listForDocument(type, documentId);
    });
  }

  /**
   * accessor に該当する共有エントリから最大 permission を返す。
   * edit が view より優先。該当がなければ undefined。
   */
  async resolvePermission(
    type: DocumentType,
    documentId: string,
    accessor: ShareAccessor,
  ): Promise<SharePermission | undefined> {
    const rows = await this.matchingShareRows(type, documentId, accessor);
    return maxPermission(rows.map((row) => row.permission));
  }

  /**
   * accessor 宛て共有が存在する documentId と、その最大 permission の Map を返す。
   */
  async listAccessibleDocumentIds(
    type: DocumentType,
    accessor: ShareAccessor,
  ): Promise<Map<string, SharePermission>> {
    const { sql, params } = this.accessorMatchClause(accessor);
    const rows = await this.db.query<{ document_id: string; permission: string }>(
      `SELECT document_id, permission
       FROM document_shares
       WHERE document_type = ? AND (${sql})`,
      [type, ...params],
    );
    const result = new Map<string, SharePermission>();
    for (const row of rows) {
      const perm = sharePermissionFromDb(row.permission);
      if (!perm) continue;
      const existing = result.get(row.document_id);
      result.set(row.document_id, maxPermissionPair(existing, perm) ?? perm);
    }
    return result;
  }

  /** ドキュメント削除時に紐づく共有エントリをすべて削除する。 */
  async deleteForDocument(type: DocumentType, documentId: string): Promise<void> {
    await this.db.run('DELETE FROM document_shares WHERE document_type = ? AND document_id = ?', [
      type,
      documentId,
    ]);
  }

  private async matchingShareRows(
    type: DocumentType,
    documentId: string,
    accessor: ShareAccessor,
  ): Promise<Array<{ permission: string }>> {
    const { sql, params } = this.accessorMatchClause(accessor);
    return this.db.query<{ permission: string }>(
      `SELECT permission
       FROM document_shares
       WHERE document_type = ? AND document_id = ? AND (${sql})`,
      [type, documentId, ...params],
    );
  }

  private accessorMatchClause(accessor: ShareAccessor): { sql: string; params: SqlParam[] } {
    const parts: string[] = ["(subject_type = 'user' AND subject_value = ?)"];
    const params: SqlParam[] = [accessor.user];

    const groups = accessor.groups.filter((group) => group.length > 0);
    if (groups.length > 0) {
      const placeholders = groups.map(() => 'LOWER(?)').join(', ');
      parts.push(`(subject_type = 'group' AND LOWER(subject_value) IN (${placeholders}))`);
      params.push(...groups.map((group) => group.toLowerCase()));
    }

    parts.push("(subject_type = 'role' AND LOWER(subject_value) = LOWER(?))");
    params.push(accessor.role);

    return { sql: parts.join(' OR '), params };
  }
}

function rowToDocumentShare(
  row: Pick<DocumentShareRow, 'subject_type' | 'subject_value' | 'permission' | 'created_at'>,
): DocumentShare {
  return documentShareSchema.parse({
    subjectType: row.subject_type,
    subjectValue: row.subject_value,
    permission: row.permission,
    createdAt: row.created_at,
  });
}

function sharePermissionFromDb(value: string): SharePermission | undefined {
  if (value === 'edit' || value === 'view') return value;
  return undefined;
}

function maxPermission(values: readonly string[]): SharePermission | undefined {
  let best: SharePermission | undefined;
  for (const value of values) {
    const perm = sharePermissionFromDb(value);
    best = maxPermissionPair(best, perm);
  }
  return best;
}

function maxPermissionPair(
  current: SharePermission | undefined,
  next: SharePermission | undefined,
): SharePermission | undefined {
  if (next === 'edit') return 'edit';
  if (next === 'view' && current === undefined) return 'view';
  return current;
}

/**
 * ノートブック（Hue Notebook 相当）機能の永続化層。`notebooks` テーブルへの
 * CRUD を提供する。ノートブック本体（セル、変数、コンテキストを含む契約型
 * `Notebook` 全体）は JSON 文字列として `data` 列にそのまま保存し、`name` /
 * `description` のみ検索用に別列へ複製して抽出する。所有分に加え、
 * `document_shares` 経由で共有されたノートブックも accessor 向けに一覧・取得できる。
 * `likeParam()` は savedQueries.ts からも再利用される
 * LIKE 検索の共通ヘルパー。
 */
import type {
  CreateNotebookRequest,
  MyPermission,
  Notebook,
  NotebookListItem,
  UpdateNotebookRequest,
} from '@hubble/contracts';
import { notebookStoredSchema } from '@hubble/contracts';
import type { SqlDatabase } from '../db/sqlDatabase';
import { newId } from '../util/id';
import {
  documentShareAccessorMatchClause,
  DocumentShareRepository,
  type ShareAccessor,
  type StoreForbidden,
} from './documentShares';

export type StoreConflict = 'conflict';

/**
 * `notebooks` テーブルの行を SQL ドライバがそのまま返す形。`data` 列には
 * 契約型 `Notebook` 全体（セル、変数、コンテキストを含む）が JSON 文字列と
 * して保存されている。
 */
interface NotebookRow {
  id: string;
  name: string;
  description: string;
  data: string;
  owner: string;
  created_at: string;
  updated_at: string;
  revision: number;
}

type NotebookListRow = Pick<
  NotebookRow,
  'id' | 'name' | 'description' | 'created_at' | 'updated_at' | 'owner'
>;

interface AccessibleNotebookListRow extends NotebookListRow {
  permission_rank: number;
}

/**
 * CRUD for notebooks. The full `Notebook` (cells/variables/context) is stored
 * as JSON in `data`; `name`/`description` are also extracted for search. Every
 * operation is scoped to an accessor: a user can see / mutate their own
 * notebooks plus documents shared with them.
 *
 * ノートブックに対する CRUD リポジトリ。`Notebook`（セル/変数/コンテキスト）
 * 全体は `data` 列に JSON として保存し、`name`/`description` は検索用に別列
 * へも抽出する。全操作は accessor でスコープされ、所有分に加え
 * document_shares 経由で共有されたノートブックも参照できる。
 */
export class NotebookRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly shares: DocumentShareRepository,
  ) {}

  /**
   * accessor が所有または共有経由で参照できるノートブック一覧（軽量な
   * `NotebookListItem`、`data` 列は含まない）を更新日時の新しい順に返す。
   * `query` が指定されれば name/description に対する部分一致（LIKE）で
   * 絞り込む（共有分にも適用される）。
   */
  async list(accessor: ShareAccessor, query?: string): Promise<NotebookListItem[]> {
    const { sql: accessorSql, params: accessorParams } = documentShareAccessorMatchClause(accessor);
    const searchSql =
      query && query.trim() !== ''
        ? ` AND (n.name LIKE ? ESCAPE '\\' OR n.description LIKE ? ESCAPE '\\')`
        : '';
    const searchParams = query && query.trim() !== '' ? [likeParam(query), likeParam(query)] : [];
    const rows = await this.db.query<AccessibleNotebookListRow>(
      `SELECT n.id, n.name, n.description, n.owner, n.created_at, n.updated_at,
              MAX(CASE WHEN ds.permission = 'edit' THEN 2
                       WHEN ds.permission = 'view' THEN 1 ELSE 0 END) AS permission_rank
       FROM notebooks n
       LEFT JOIN document_shares ds
         ON ds.document_type = 'notebook' AND ds.document_id = n.id
        AND ds.permission IN ('view', 'edit') AND (${accessorSql})
       WHERE (n.owner = ? OR ds.id IS NOT NULL)${searchSql}
       GROUP BY n.id, n.name, n.description, n.owner, n.created_at, n.updated_at
       ORDER BY n.updated_at DESC`,
      [...accessorParams, accessor.user, ...searchParams],
    );
    return rows.map((row) =>
      rowToListItem(
        row,
        row.owner,
        row.owner === accessor.user ? 'owner' : row.permission_rank === 2 ? 'edit' : 'view',
      ),
    );
  }

  /**
   * owner 条件なしで id からノートブックを取得する。
   * ガバナンス判定専用。認可は呼び出し側の責務で、返り値を API レスポンスへ直接使わないこと。
   */
  async getByIdUnscoped(id: string): Promise<Notebook | undefined> {
    const row = await this.getRowById(id);
    return row ? this.rowToNotebook(row) : undefined;
  }

  /** accessor が参照可能な単一ノートブックを id で取得する（`data` 列を含む完全な形）。 */
  async get(accessor: ShareAccessor, id: string): Promise<Notebook | undefined> {
    const owned = await this.getOwnedRow(id, accessor.user);
    if (owned) {
      return withAccessMeta(this.rowToNotebook(owned), owned.owner, 'owner');
    }
    const permission = await this.shares.resolvePermission('notebook', id, accessor);
    if (!permission) return undefined;
    const row = await this.getRowById(id);
    if (!row) return undefined;
    return withAccessMeta(this.rowToNotebook(row), row.owner, permission);
  }

  /** 新しいノートブックを作成する。id は `nb_` プレフィックス付きで採番される。 */
  async create(owner: string, req: CreateNotebookRequest): Promise<Notebook> {
    const nowIso = new Date().toISOString();
    // 契約スキーマでバリデーションと既定値補完（cells/variables/context の
    // 未指定は空配列/空オブジェクト）をした上でドメインオブジェクトを組み立てる。
    const notebook: Notebook = notebookStoredSchema.parse({
      id: newId('nb_'),
      name: req.name,
      description: req.description ?? '',
      cells: req.cells ?? [],
      variables: req.variables ?? [],
      context: req.context ?? {},
      createdAt: nowIso,
      updatedAt: nowIso,
      revision: 1,
    });
    await this.db.run(
      `INSERT INTO notebooks (id, name, description, data, owner, created_at, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        notebook.id,
        notebook.name,
        notebook.description,
        // ノートブック全体を JSON 文字列化して data 列に保存する。
        JSON.stringify(notebook),
        owner,
        notebook.createdAt,
        notebook.updatedAt,
        notebook.revision,
      ],
    );
    return withAccessMeta(notebook, owner, 'owner');
  }

  /**
   * 既存のノートブックを更新する。owner または edit 共有者のみ更新可能。
   * view のみの場合は 'forbidden'、対象が存在しないか権限がなければ undefined。
   */
  async update(
    accessor: ShareAccessor,
    id: string,
    req: UpdateNotebookRequest,
  ): Promise<Notebook | undefined | StoreForbidden | StoreConflict> {
    const owned = await this.getOwnedRow(id, accessor.user);
    if (owned) {
      return this.applyUpdate(owned, req, accessor.user, 'owner');
    }

    const permission = await this.shares.resolvePermission('notebook', id, accessor);
    if (!permission) return undefined;
    if (permission === 'view') return 'forbidden';

    const existing = await this.getRowById(id);
    if (!existing) return undefined;
    return this.applyUpdate(existing, req, existing.owner, 'edit');
  }

  /**
   * ノートブックを削除する。owner のみ可能。削除できたら true、対象が
   * 存在しなければ false、共有されているが owner でない場合は 'forbidden'。
   */
  async delete(accessor: ShareAccessor, id: string): Promise<boolean | StoreForbidden> {
    const owner = await this.getOwner(id);
    if (!owner) return false;
    if (owner !== accessor.user) {
      const permission = await this.shares.resolvePermission('notebook', id, accessor);
      if (permission) return 'forbidden';
      return false;
    }

    return this.db.transaction(async (tx) => {
      const deleted = await tx.query<{ id: string }>(
        'DELETE FROM notebooks WHERE id = ? AND owner = ? RETURNING id',
        [id, accessor.user],
      );
      if (deleted.length === 0) return false;
      await new DocumentShareRepository(tx).deleteForDocument('notebook', id);
      return true;
    });
  }

  /** ドキュメント id から owner user id を返す。存在しなければ undefined。 */
  async getOwner(id: string): Promise<string | undefined> {
    const rows = await this.db.query<{ owner: string }>(
      'SELECT owner FROM notebooks WHERE id = ?',
      [id],
    );
    return rows[0]?.owner;
  }

  private async getOwnedRow(id: string, owner: string): Promise<NotebookRow | undefined> {
    const rows = await this.db.query<NotebookRow>(
      'SELECT * FROM notebooks WHERE id = ? AND owner = ?',
      [id, owner],
    );
    return rows[0];
  }

  private async getRowById(id: string): Promise<NotebookRow | undefined> {
    const rows = await this.db.query<NotebookRow>('SELECT * FROM notebooks WHERE id = ?', [id]);
    return rows[0];
  }

  private async applyUpdate(
    existing: NotebookRow,
    req: UpdateNotebookRequest,
    owner: string,
    myPermission: MyPermission,
  ): Promise<Notebook | undefined | StoreConflict> {
    // 既存値の上に req の値をマージし、スキーマで再バリデーションする。
    const updated: Notebook = notebookStoredSchema.parse({
      ...this.rowToNotebook(existing),
      name: req.name,
      description: req.description,
      cells: req.cells,
      variables: req.variables,
      context: req.context,
      updatedAt: new Date().toISOString(),
      revision: req.revision + 1,
    });
    const rows = await this.db.query<NotebookRow>(
      `UPDATE notebooks SET name = ?, description = ?, data = ?, updated_at = ?,
       revision = revision + 1
       WHERE id = ? AND owner = ? AND revision = ?
       RETURNING *`,
      [
        updated.name,
        updated.description,
        JSON.stringify(updated),
        updated.updatedAt,
        existing.id,
        owner,
        req.revision,
      ],
    );
    const row = rows[0];
    if (row) return withAccessMeta(this.rowToNotebook(row), owner, myPermission);
    return (await this.getRowById(existing.id)) ? 'conflict' : undefined;
  }

  private rowToNotebook(row: NotebookRow): Notebook {
    // `data` is the source of truth; parse + validate against the contract.
    // `data` 列（JSON 文字列）が正であり、name/description 列は検索用の複製に
    // すぎないため無視する。パース結果を契約スキーマで検証してから返す。
    return notebookStoredSchema.parse({
      ...(JSON.parse(row.data) as Record<string, unknown>),
      revision: Number(row.revision),
    });
  }
}

function withAccessMeta(notebook: Notebook, owner: string, myPermission: MyPermission): Notebook {
  return { ...notebook, owner, myPermission };
}

function rowToListItem(
  row: NotebookListRow,
  owner: string,
  myPermission: MyPermission,
): NotebookListItem {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    owner,
    myPermission,
  };
}

/** Escape LIKE wildcards and wrap with `%…%` for a contains match. */
// LIKE 検索のワイルドカード（\, %, _）をエスケープしてから `%…%` で囲み、
// 部分一致（contains）検索用のパターンに変換する。呼び出し側の SQL は
// `ESCAPE '\\'` を指定してこのエスケープ文字を認識する必要がある。
export function likeParam(query: string): string {
  const escaped = query.replace(/[\\%_]/g, (c) => `\\${c}`);
  return `%${escaped}%`;
}

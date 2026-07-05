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
import { notebookSchema } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { newId } from '../util/id';
import { DocumentShareRepository, type ShareAccessor, type StoreForbidden } from './documentShares';

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
}

type NotebookListRow = Pick<
  NotebookRow,
  'id' | 'name' | 'description' | 'created_at' | 'updated_at' | 'owner'
>;

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
    const ownedRows = await this.listOwnedRows(accessor.user, query);
    const ownedIds = new Set(ownedRows.map((row) => row.id));
    const sharedIds = await this.shares.listAccessibleDocumentIds('notebook', accessor);
    const sharedOnlyIds = [...sharedIds.keys()].filter((id) => !ownedIds.has(id));
    const sharedRows =
      sharedOnlyIds.length > 0 ? await this.fetchListRowsByIds(sharedOnlyIds, query) : [];

    const items: NotebookListItem[] = [
      ...ownedRows.map((row) => rowToListItem(row, row.owner, 'owner')),
      ...sharedRows.map((row) => rowToListItem(row, row.owner, sharedIds.get(row.id)!)),
    ];
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return items;
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
    const notebook: Notebook = notebookSchema.parse({
      id: newId('nb_'),
      name: req.name,
      description: req.description ?? '',
      cells: req.cells ?? [],
      variables: req.variables ?? [],
      context: req.context ?? {},
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this.db.run(
      `INSERT INTO notebooks (id, name, description, data, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        notebook.id,
        notebook.name,
        notebook.description,
        // ノートブック全体を JSON 文字列化して data 列に保存する。
        JSON.stringify(notebook),
        owner,
        notebook.createdAt,
        notebook.updatedAt,
      ],
    );
    return notebook;
  }

  /**
   * 既存のノートブックを更新する。owner または edit 共有者のみ更新可能。
   * view のみの場合は 'forbidden'、対象が存在しないか権限がなければ undefined。
   */
  async update(
    accessor: ShareAccessor,
    id: string,
    req: UpdateNotebookRequest,
  ): Promise<Notebook | undefined | StoreForbidden> {
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

  private async listOwnedRows(owner: string, query?: string): Promise<NotebookListRow[]> {
    if (query && query.trim() !== '') {
      return this.db.query<NotebookListRow>(
        `SELECT id, name, description, owner, created_at, updated_at FROM notebooks
         WHERE owner = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
         ORDER BY updated_at DESC`,
        [owner, likeParam(query), likeParam(query)],
      );
    }
    return this.db.query<NotebookListRow>(
      `SELECT id, name, description, owner, created_at, updated_at FROM notebooks
       WHERE owner = ? ORDER BY updated_at DESC`,
      [owner],
    );
  }

  private async fetchListRowsByIds(
    ids: readonly string[],
    query?: string,
  ): Promise<NotebookListRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const params: SqlParam[] = [...ids];
    let sql = `SELECT id, name, description, owner, created_at, updated_at FROM notebooks WHERE id IN (${placeholders})`;
    if (query && query.trim() !== '') {
      sql += ` AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`;
      params.push(likeParam(query), likeParam(query));
    }
    return this.db.query<NotebookListRow>(sql, params);
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
  ): Promise<Notebook> {
    // 既存値の上に req の値をマージし、スキーマで再バリデーションする。
    const updated: Notebook = notebookSchema.parse({
      ...this.rowToNotebook(existing),
      name: req.name,
      description: req.description,
      cells: req.cells,
      variables: req.variables,
      context: req.context,
      updatedAt: new Date().toISOString(),
    });
    await this.db.run(
      `UPDATE notebooks SET name = ?, description = ?, data = ?, updated_at = ?
       WHERE id = ? AND owner = ?`,
      [
        updated.name,
        updated.description,
        JSON.stringify(updated),
        updated.updatedAt,
        existing.id,
        owner,
      ],
    );
    return withAccessMeta(updated, owner, myPermission);
  }

  private rowToNotebook(row: NotebookRow): Notebook {
    // `data` is the source of truth; parse + validate against the contract.
    // `data` 列（JSON 文字列）が正であり、name/description 列は検索用の複製に
    // すぎないため無視する。パース結果を契約スキーマで検証してから返す。
    return notebookSchema.parse(JSON.parse(row.data));
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

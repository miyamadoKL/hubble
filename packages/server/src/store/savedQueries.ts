/**
 * 保存済みクエリ（Saved Query）機能の永続化層。`saved_queries` テーブルへの
 * CRUD と、名前/SQL文/説明を対象とした `?query=` の部分一致検索を提供する。
 * お気に入り（is_favorite）を先頭に並べる点が一覧取得の特徴。所有分に加え、
 * `document_shares` 経由で共有されたクエリも accessor 向けに一覧・取得できる。
 * アーキテクチャ上は `SqlDatabase` 抽象の上に乗るリポジトリ
 * 層で、契約型 `SavedQuery`（packages/contracts）との変換をこのファイルが担う。
 */
import type {
  CreateSavedQueryRequest,
  MyPermission,
  SavedQuery,
  UpdateSavedQueryRequest,
} from '@hubble/contracts';
import { savedQuerySchema } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { newId } from '../util/id';
import { DocumentShareRepository, type ShareAccessor, type StoreForbidden } from './documentShares';
import { likeParam } from './notebooks';

/**
 * `saved_queries` テーブルの行を SQL ドライバがそのまま返す形。列名は
 * snake_case、`is_favorite` は 0/1 の INTEGER として保存されている。
 */
interface SavedQueryRow {
  id: string;
  name: string;
  description: string;
  statement: string;
  catalog: string | null;
  schema: string | null;
  datasource_id: string | null;
  is_favorite: number;
  owner: string;
  created_at: string;
  updated_at: string;
}

/**
 * CRUD for saved queries with a `?query=` LIKE search over name/statement.
 * Every operation is scoped to an accessor (owner or shared permission).
 *
 * 保存済みクエリに対する CRUD と、name/statement/description を対象にした
 * `?query=` の LIKE 検索を提供するリポジトリ。全操作は accessor でスコープされ、
 * 所有分に加え document_shares 経由で共有されたクエリも参照できる。
 */
export class SavedQueryRepository {
  constructor(
    private readonly db: SqlDatabase,
    private readonly shares: DocumentShareRepository,
  ) {}

  /**
   * accessor が所有または共有経由で参照できる保存済みクエリを返す。
   * 所有分のお気に入りのみ先頭に並べ、残りは updated_at 降順。`query` が
   * 指定された場合は name/statement/description に対する部分一致（LIKE）で
   * 絞り込む（共有分にも適用される）。
   */
  async list(accessor: ShareAccessor, query?: string): Promise<SavedQuery[]> {
    const ownedRows = await this.listOwnedRows(accessor.user, query);
    const ownedIds = new Set(ownedRows.map((row) => row.id));
    const sharedIds = await this.shares.listAccessibleDocumentIds('saved_query', accessor);
    const sharedOnlyIds = [...sharedIds.keys()].filter((id) => !ownedIds.has(id));
    const sharedRows =
      sharedOnlyIds.length > 0 ? await this.fetchRowsByIds(sharedOnlyIds, query) : [];

    const items: SavedQuery[] = [
      ...ownedRows.map((row) => withAccessMeta(rowToSavedQuery(row), row.owner, 'owner')),
      ...sharedRows.map((row) =>
        withAccessMeta(rowToSavedQuery(row), row.owner, sharedIds.get(row.id)!),
      ),
    ];
    return sortSavedQueries(items);
  }

  /**
   * owner 条件なしで id から保存済みクエリを取得する。
   * ガバナンス判定専用。認可は呼び出し側の責務で、返り値を API レスポンスへ直接使わないこと。
   */
  async getByIdUnscoped(id: string): Promise<SavedQuery | undefined> {
    const row = await this.getRowById(id);
    return row ? rowToSavedQuery(row) : undefined;
  }

  /** accessor が参照可能な単一の保存済みクエリを id で取得する。存在しないか権限がなければ undefined。 */
  async get(accessor: ShareAccessor, id: string): Promise<SavedQuery | undefined> {
    const owned = await this.getOwnedRow(id, accessor.user);
    if (owned) {
      return withAccessMeta(rowToSavedQuery(owned), owned.owner, 'owner');
    }
    const permission = await this.shares.resolvePermission('saved_query', id, accessor);
    if (!permission) return undefined;
    const row = await this.getRowById(id);
    if (!row) return undefined;
    return withAccessMeta(rowToSavedQuery(row), row.owner, permission);
  }

  /** 新しい保存済みクエリを作成する。id は `sq_` プレフィックス付きで採番される。 */
  async create(owner: string, req: CreateSavedQueryRequest): Promise<SavedQuery> {
    const nowIso = new Date().toISOString();
    // 契約スキーマでバリデーションと正規化をした上でドメインオブジェクトを組み立てる。
    const saved: SavedQuery = savedQuerySchema.parse({
      id: newId('sq_'),
      name: req.name,
      description: req.description ?? '',
      statement: req.statement,
      catalog: req.catalog,
      schema: req.schema,
      datasourceId: req.datasourceId,
      isFavorite: req.isFavorite ?? false,
      createdAt: nowIso,
      updatedAt: nowIso,
    });
    await this.db.run(
      `INSERT INTO saved_queries (id, name, description, statement, catalog, schema, datasource_id, is_favorite, owner, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      insertParams(saved, owner),
    );
    return saved;
  }

  /**
   * 既存の保存済みクエリを更新する。owner または edit 共有者のみ更新可能。
   * view のみの場合は 'forbidden'、対象が存在しないか権限がなければ undefined。
   */
  async update(
    accessor: ShareAccessor,
    id: string,
    req: UpdateSavedQueryRequest,
  ): Promise<SavedQuery | undefined | StoreForbidden> {
    const owned = await this.getOwnedRow(id, accessor.user);
    if (owned) {
      return this.applyUpdate(owned, req, accessor.user, req.isFavorite, 'owner');
    }

    const permission = await this.shares.resolvePermission('saved_query', id, accessor);
    if (!permission) return undefined;
    if (permission === 'view') return 'forbidden';

    const existing = await this.getRowById(id);
    if (!existing) return undefined;
    // お気に入りは owner の状態のため、edit 共有者による更新では既存値を維持する。
    // ドライバが is_favorite を文字列で返す可能性に備え、rowToSavedQuery と
    // 同じく Number() で数値化してから真偽値化する。
    return this.applyUpdate(
      existing,
      req,
      existing.owner,
      Number(existing.is_favorite) !== 0,
      'edit',
    );
  }

  /**
   * 保存済みクエリを削除する。owner のみ可能。削除できたら true、対象が
   * 存在しなければ false、共有されているが owner でない場合は 'forbidden'。
   */
  async delete(accessor: ShareAccessor, id: string): Promise<boolean | StoreForbidden> {
    const owner = await this.getOwner(id);
    if (!owner) return false;
    if (owner !== accessor.user) {
      const permission = await this.shares.resolvePermission('saved_query', id, accessor);
      if (permission) return 'forbidden';
      return false;
    }

    return this.db.transaction(async (tx) => {
      const deleted = await tx.query<{ id: string }>(
        'DELETE FROM saved_queries WHERE id = ? AND owner = ? RETURNING id',
        [id, accessor.user],
      );
      if (deleted.length === 0) return false;
      await new DocumentShareRepository(tx).deleteForDocument('saved_query', id);
      return true;
    });
  }

  /** ドキュメント id から owner user id を返す。存在しなければ undefined。 */
  async getOwner(id: string): Promise<string | undefined> {
    const rows = await this.db.query<{ owner: string }>(
      'SELECT owner FROM saved_queries WHERE id = ?',
      [id],
    );
    return rows[0]?.owner;
  }

  private async listOwnedRows(owner: string, query?: string): Promise<SavedQueryRow[]> {
    if (query && query.trim() !== '') {
      return this.db.query<SavedQueryRow>(
        `SELECT * FROM saved_queries
         WHERE owner = ? AND (name LIKE ? ESCAPE '\\' OR statement LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
         ORDER BY is_favorite DESC, updated_at DESC`,
        [owner, likeParam(query), likeParam(query), likeParam(query)],
      );
    }
    return this.db.query<SavedQueryRow>(
      `SELECT * FROM saved_queries WHERE owner = ? ORDER BY is_favorite DESC, updated_at DESC`,
      [owner],
    );
  }

  private async fetchRowsByIds(ids: readonly string[], query?: string): Promise<SavedQueryRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const params: SqlParam[] = [...ids];
    let sql = `SELECT * FROM saved_queries WHERE id IN (${placeholders})`;
    if (query && query.trim() !== '') {
      sql += ` AND (name LIKE ? ESCAPE '\\' OR statement LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`;
      params.push(likeParam(query), likeParam(query), likeParam(query));
    }
    return this.db.query<SavedQueryRow>(sql, params);
  }

  private async getOwnedRow(id: string, owner: string): Promise<SavedQueryRow | undefined> {
    const rows = await this.db.query<SavedQueryRow>(
      'SELECT * FROM saved_queries WHERE id = ? AND owner = ?',
      [id, owner],
    );
    return rows[0];
  }

  private async getRowById(id: string): Promise<SavedQueryRow | undefined> {
    const rows = await this.db.query<SavedQueryRow>('SELECT * FROM saved_queries WHERE id = ?', [
      id,
    ]);
    return rows[0];
  }

  private async applyUpdate(
    existing: SavedQueryRow,
    req: UpdateSavedQueryRequest,
    owner: string,
    isFavorite: boolean,
    myPermission: MyPermission,
  ): Promise<SavedQuery> {
    // 既存値の上に req の値をマージし、スキーマで再バリデーションする。
    const updated: SavedQuery = savedQuerySchema.parse({
      ...rowToSavedQuery(existing),
      name: req.name,
      description: req.description,
      statement: req.statement,
      catalog: req.catalog,
      schema: req.schema,
      datasourceId: req.datasourceId,
      isFavorite,
      updatedAt: new Date().toISOString(),
    });
    await this.db.run(
      `UPDATE saved_queries SET name=?, description=?, statement=?,
         catalog=?, schema=?, datasource_id=?, is_favorite=?, updated_at=?
       WHERE id=? AND owner=?`,
      [
        updated.name,
        updated.description,
        updated.statement,
        updated.catalog ?? null,
        updated.schema ?? null,
        updated.datasourceId ?? null,
        updated.isFavorite ? 1 : 0,
        updated.updatedAt,
        existing.id,
        owner,
      ],
    );
    return withAccessMeta(updated, owner, myPermission);
  }
}

function withAccessMeta(saved: SavedQuery, owner: string, myPermission: MyPermission): SavedQuery {
  return { ...saved, owner, myPermission };
}

function sortSavedQueries(items: SavedQuery[]): SavedQuery[] {
  const ownedFavorites = items.filter((item) => item.myPermission === 'owner' && item.isFavorite);
  const rest = items.filter((item) => !(item.myPermission === 'owner' && item.isFavorite));
  rest.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  ownedFavorites.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return [...ownedFavorites, ...rest];
}

// DB 行をドメインオブジェクト `SavedQuery` へ変換する。catalog/schema は空文字
// なら省略し（optional フィールドとして扱う）、最後に契約スキーマで検証する。
function rowToSavedQuery(row: SavedQueryRow): SavedQuery {
  const q: SavedQuery = {
    id: row.id,
    name: row.name,
    description: row.description,
    statement: row.statement,
    // SQLite stores 0/1; PostgreSQL's INTEGER column round-trips the same value.
    // SQLite は 0/1 で保持し、PostgreSQL の INTEGER 列も同じ値を往復するため
    // Number() で数値化してから 0 かどうかで真偽値化する。
    isFavorite: Number(row.is_favorite) !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.catalog) q.catalog = row.catalog;
  if (row.schema) q.schema = row.schema;
  if (row.datasource_id) q.datasourceId = row.datasource_id;
  return savedQuerySchema.parse(q);
}

/** Positional params for the INSERT, matching the column order above. */
// 上記 INSERT 文のプレースホルダ順に合わせて値を配列化する。
function insertParams(q: SavedQuery, owner: string): SqlParam[] {
  return [
    q.id,
    q.name,
    q.description,
    q.statement,
    q.catalog ?? null,
    q.schema ?? null,
    q.datasourceId ?? null,
    q.isFavorite ? 1 : 0,
    owner,
    q.createdAt,
    q.updatedAt,
  ];
}

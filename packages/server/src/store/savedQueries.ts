/**
 * 保存済みクエリ（Saved Query）機能の永続化層。`saved_queries` テーブルへの
 * CRUD と、名前/SQL文/説明を対象とした `?query=` の部分一致検索を提供する。
 * お気に入り（is_favorite）を先頭に並べる点が一覧取得の特徴。全操作は
 * `owner` principal で絞り込まれ、他ユーザーの保存済みクエリは参照できない。
 * アーキテクチャ上は `SqlDatabase` 抽象の上に乗るリポジトリ
 * 層で、契約型 `SavedQuery`（packages/contracts）との変換をこのファイルが担う。
 */
import type {
  CreateSavedQueryRequest,
  SavedQuery,
  UpdateSavedQueryRequest,
} from '@hubble/contracts';
import { savedQuerySchema } from '@hubble/contracts';
import type { SqlDatabase, SqlParam } from '../db/sqlDatabase';
import { newId } from '../util/id';
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
  created_at: string;
  updated_at: string;
}

/**
 * CRUD for saved queries with a `?query=` LIKE search over name/statement.
 * Every operation is scoped to an `owner` principal.
 *
 * 保存済みクエリに対する CRUD と、name/statement/description を対象にした
 * `?query=` の LIKE 検索を提供するリポジトリ。全操作は `owner` principal で
 * 絞り込まれる。
 */
export class SavedQueryRepository {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * owner の保存済みクエリを、お気に入り優先で更新日時降順に返す。`query` が
   * 指定された場合は name/statement/description に対する部分一致（LIKE）で
   * 絞り込む。
   */
  async list(owner: string, query?: string): Promise<SavedQuery[]> {
    const rows =
      query && query.trim() !== ''
        ? await this.db.query<SavedQueryRow>(
            `SELECT * FROM saved_queries
             WHERE owner = ? AND (name LIKE ? ESCAPE '\\' OR statement LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')
             ORDER BY is_favorite DESC, updated_at DESC`,
            [owner, likeParam(query), likeParam(query), likeParam(query)],
          )
        : await this.db.query<SavedQueryRow>(
            `SELECT * FROM saved_queries WHERE owner = ? ORDER BY is_favorite DESC, updated_at DESC`,
            [owner],
          );
    return rows.map(rowToSavedQuery);
  }

  /** owner が所有する単一の保存済みクエリを id で取得する。存在しなければ undefined。 */
  async get(owner: string, id: string): Promise<SavedQuery | undefined> {
    const rows = await this.db.query<SavedQueryRow>(
      'SELECT * FROM saved_queries WHERE id = ? AND owner = ?',
      [id, owner],
    );
    return rows[0] ? rowToSavedQuery(rows[0]) : undefined;
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

  /** 既存の保存済みクエリを更新する。対象が owner のクエリとして存在しなければ undefined。 */
  async update(
    owner: string,
    id: string,
    req: UpdateSavedQueryRequest,
  ): Promise<SavedQuery | undefined> {
    const existing = await this.get(owner, id);
    if (!existing) return undefined;
    // 既存値の上に req の値をマージし、スキーマで再バリデーションする。
    const updated: SavedQuery = savedQuerySchema.parse({
      ...existing,
      name: req.name,
      description: req.description,
      statement: req.statement,
      catalog: req.catalog,
      schema: req.schema,
      datasourceId: req.datasourceId,
      isFavorite: req.isFavorite,
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
        id,
        owner,
      ],
    );
    return updated;
  }

  /** 保存済みクエリを削除する。削除できたら true、対象が存在しなければ false。 */
  async delete(owner: string, id: string): Promise<boolean> {
    const deleted = await this.db.query<{ id: string }>(
      'DELETE FROM saved_queries WHERE id = ? AND owner = ? RETURNING id',
      [id, owner],
    );
    return deleted.length > 0;
  }
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
